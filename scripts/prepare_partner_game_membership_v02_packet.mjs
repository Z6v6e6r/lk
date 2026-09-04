#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import {
  buildPartnerGameMembershipApiCandidate,
  buildPartnerGameMembershipApiSidecarCandidate,
  PARTNER_API_FLOW_NODE_IDS,
} from "./patch_partner_game_membership_api_flow.mjs";
import { verifyWorkspace } from "./verify_nodered_source_origin.mjs";
import {
  buildExactGraphContract,
  sha256,
  syncDirectory,
  validateExactGraphContract,
} from "./nodered_reviewed_flow_deploy/runtime_contract.mjs";
import { validatePartnerProductionControls } from "./validate_partner_game_membership_production_controls.mjs";
import {
  validateCheckedPartnerRuntimeEvidence,
  validatePartnerRuntimeEvidence,
} from "./validate_partner_game_membership_runtime.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = fs.realpathSync(path.resolve(SCRIPT_DIR, ".."));
const NODE_PACKAGE_ROOT = path.join(REPO_ROOT, "node-red/custom-nodes/partner-game-membership-api");
const SIDECAR_TEMPLATE_ROOT = path.join(REPO_ROOT, "scripts/partner_game_membership_sidecar");
const PRODUCTION_CONTROLS_PATH = path.join(REPO_ROOT, "scripts/partner_game_membership_production_controls.json");
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const DEPLOYMENT_ID = "partner-game-membership-api-v02";
const RELEASE_FILES = Object.freeze([
  "package.json",
  "package-lock.json",
  "partner-game-membership-core.mjs",
  "partner-game-membership-mongo.mjs",
  "partner-game-membership-viva.mjs",
  "partner-game-membership-node.cjs",
  "partner-game-membership-node.html",
]);
const RUNTIME_ARTIFACT_FILES = Object.freeze([
  "package.json",
  "package-lock.json",
  "dependency-tree.json",
  "audit-report.json",
  "functional-rehearsal.json",
  "runtime-manifest.json",
]);
const SIDECAR_TEMPLATE_FILES = Object.freeze([
  "settings.cjs",
  "partner-game-membership-sidecar.service",
  "sidecar-rehearsal.json",
]);

const isWithin = (parent, candidate) => {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

function repositoryIdentity() {
  const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" });
  const tree = spawnSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: REPO_ROOT, encoding: "utf8" });
  const branch = spawnSync("git", ["branch", "--show-current"], { cwd: REPO_ROOT, encoding: "utf8" });
  const status = spawnSync("git", ["status", "--porcelain"], { cwd: REPO_ROOT, encoding: "utf8" });
  const repository = {
    commit: revision.stdout.trim(),
    tree: tree.stdout.trim(),
    branch: branch.stdout.trim(),
  };
  if (revision.status !== 0 || tree.status !== 0 || branch.status !== 0
    || !COMMIT_PATTERN.test(repository.commit) || !COMMIT_PATTERN.test(repository.tree) || !repository.branch) {
    throw new Error("Pilot packet requires an exact task-branch commit");
  }
  if (status.status !== 0 || status.stdout.trim()) throw new Error("Pilot packet requires a clean worktree");
  return repository;
}

function validateRepositoryIdentity(repository) {
  if (!repository
    || !COMMIT_PATTERN.test(String(repository.commit || ""))
    || !COMMIT_PATTERN.test(String(repository.tree || ""))
    || !String(repository.branch || "").trim()) {
    throw new Error("Pilot packet requires an exact repository identity");
  }
  return { commit: repository.commit, tree: repository.tree, branch: repository.branch.trim() };
}

export function assertExternalNewPacketDirectory(outArg) {
  if (!outArg || !path.isAbsolute(outArg)) throw new Error("Pilot packet output must be absolute");
  const output = path.resolve(outArg);
  const parent = path.dirname(output);
  const stat = fs.lstatSync(parent);
  const canonicalParent = fs.realpathSync(parent);
  const expectedUid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
  if (!stat.isDirectory()
    || stat.isSymbolicLink()
    || canonicalParent !== parent
    || stat.uid !== expectedUid
    || (stat.mode & 0o777) !== 0o700) {
    throw new Error("Pilot packet parent must be a private user-owned canonical directory with mode 0700");
  }
  const canonicalOutput = path.join(canonicalParent, path.basename(output));
  if (isWithin(REPO_ROOT, canonicalOutput)) throw new Error("Pilot packet must be outside the repository");
  if (fs.existsSync(canonicalOutput)) throw new Error("Pilot packet output must not already exist");
  return canonicalOutput;
}

function writePrivateBytes(filePath, bytes) {
  const descriptor = fs.openSync(filePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  try {
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

const writePrivateJson = (filePath, value) => writePrivateBytes(
  filePath,
  Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"),
);

function listPacketFiles(root, relativeDirectory = "") {
  const directory = path.join(root, relativeDirectory);
  return fs.readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      const absolutePath = path.join(root, relativePath);
      if (entry.isSymbolicLink()) throw new Error(`Pilot packet cannot contain symlinks: ${relativePath}`);
      if (entry.isDirectory()) return listPacketFiles(root, relativePath);
      const stat = fs.lstatSync(absolutePath);
      if (!entry.isFile() || !stat.isFile() || stat.nlink !== 1) {
        throw new Error(`Pilot packet contains a non-regular file: ${relativePath}`);
      }
      return [{
        relativePath,
        sha256: sha256(fs.readFileSync(absolutePath)),
        size: stat.size,
        mode: (stat.mode & 0o777).toString(8).padStart(4, "0"),
      }];
    });
}

function buildPacketManifest({ output, repository, plan }) {
  const files = listPacketFiles(output);
  return {
    formatVersion: 1,
    deploymentId: DEPLOYMENT_ID,
    state: "COMPLETE_PRIVATE_PACKET",
    repository,
    productionControlsSha256: plan.productionControlsSha256,
    customNodeReleaseSha256: plan.customNodeReleaseSha256,
    files,
    aggregateSha256: sha256(Buffer.from(JSON.stringify(files), "utf8")),
    deployAuthorized: false,
    activationAuthorized: false,
  };
}

export function rehearseExactByteRollback({ liveBytes, candidateBytes, contract }) {
  validateExactGraphContract({ liveBytes, candidateBytes, contract });
  let simulatedActive = Buffer.from(candidateBytes);
  if (sha256(simulatedActive) !== contract.candidateSha256) {
    throw new Error("Pilot rollback rehearsal candidate publication mismatch");
  }
  simulatedActive = Buffer.from(liveBytes);
  if (sha256(simulatedActive) !== contract.sourceSha256) {
    throw new Error("Pilot rollback rehearsal source restoration mismatch");
  }
  return true;
}

export function validatePartnerSidecarArtifacts({ artifacts, candidateBytes, sidecarControls }) {
  if (!artifacts || !Buffer.isBuffer(candidateBytes) || !sidecarControls) {
    throw new Error("Pilot packet requires exact sidecar artifact bytes and controls");
  }
  const settingsBytes = artifacts["settings.cjs"];
  const serviceUnitBytes = artifacts["partner-game-membership-sidecar.service"];
  const rehearsalBytes = artifacts["sidecar-rehearsal.json"];
  if (![settingsBytes, serviceUnitBytes, rehearsalBytes].every(Buffer.isBuffer)
    || sha256(settingsBytes) !== sidecarControls.settingsSha256
    || sha256(serviceUnitBytes) !== sidecarControls.serviceUnitSha256
    || sha256(rehearsalBytes) !== sidecarControls.rehearsalSha256
    || sha256(candidateBytes) !== sidecarControls.candidateFlowSha256) {
    throw new Error("Pilot packet sidecar bytes differ from the immutable production-controls closure");
  }
  const rehearsal = JSON.parse(rehearsalBytes.toString("utf8"));
  const expected = {
    formatVersion: 1,
    capturedAt: "2026-09-04T13:05:14.000Z",
    environment: "LOCAL_DISPOSABLE_CONTAINER",
    networkMode: "none",
    runtime: {
      platform: "linux",
      architecture: "x64",
      nodeImageSha256: "83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5",
      nodeVersion: "22.23.2",
      nodeRedVersion: "5.0.6",
    },
    artifacts: {
      settingsSha256: sidecarControls.settingsSha256,
      serviceUnitSha256: sidecarControls.serviceUnitSha256,
      candidateFlowSha256: sidecarControls.candidateFlowSha256,
    },
    readback: {
      exactProductionPathLayout: true,
      emptyUserDirAtStart: true,
      customNodeRouteLoaded: true,
      bindAddress: sidecarControls.bindAddress,
      port: sidecarControls.port,
      adminUiDisabled: true,
      paletteEditorDisabled: true,
      partnerDefaultOffHttpStatus: 503,
      adminRootHttpStatus: 404,
      cacheControl: "no-store",
      corsResponseHeader: null,
      gracefulStopMarkers: ["Stopping flows", "Stopped flows"],
    },
    cleanup: { containerPresent: false, hostListenerPresent: false },
    productionTouched: false,
  };
  if (sidecarControls.topology !== "DEDICATED_LOOPBACK_SIDECAR"
    || sidecarControls.sharedFlowMutationAllowed !== false
    || !isDeepStrictEqual(rehearsal, expected)) {
    throw new Error("Pilot packet sidecar rehearsal is incomplete or differs from the approved fail-closed evidence");
  }
  return rehearsal;
}

export function buildPartnerV02DeploymentPlan({
  repository,
  verified,
  contract,
  release,
  rollbackRehearsed,
  productionControls,
  productionControlsBytes,
  productionControlsSha256,
  runtimeEvidence,
}) {
  validateRepositoryIdentity(repository);
  validatePartnerProductionControls(productionControls);
  if (!Buffer.isBuffer(productionControlsBytes)
    || sha256(productionControlsBytes) !== productionControlsSha256
    || !isDeepStrictEqual(JSON.parse(productionControlsBytes.toString("utf8")), productionControls)) {
    throw new Error("Pilot packet requires an exact production-controls identity");
  }
  if (productionControls.runtime.latestIsolatedRehearsal.customNodeReleaseSha256 !== release.releaseSha256) {
    throw new Error("Pilot packet custom-node release lacks matching runtime rehearsal evidence");
  }
  if (productionControls.runtime.latestIsolatedRehearsal.evidenceScope
    !== "CUSTOM_NODE_LOAD_DEFAULT_OFF_AND_REMOVAL_COMPATIBILITY_ONLY"
    || runtimeEvidence.functionalRehearsal.evidenceScope
      !== productionControls.runtime.latestIsolatedRehearsal.evidenceScope) {
    throw new Error("Pilot packet runtime rehearsal scope is missing or overclaimed");
  }
  if (runtimeEvidence.manifestSha256 !== productionControls.runtime.immutableClosure.runtimeManifestSha256
    || runtimeEvidence.manifest.closure.customNodeReleaseSha256 !== release.releaseSha256
    || runtimeEvidence.manifest.closure.packageLockSha256 !== productionControls.runtime.immutableClosure.packageLockSha256
    || runtimeEvidence.manifest.closure.dependencyTreeSha256 !== productionControls.runtime.immutableClosure.dependencyTreeSha256
    || runtimeEvidence.manifest.closure.auditReportSha256 !== productionControls.runtime.immutableClosure.auditReportSha256
    || runtimeEvidence.manifest.closure.functionalRehearsalSha256 !== productionControls.runtime.immutableClosure.functionalRehearsalSha256
    || runtimeEvidence.functionalRehearsal.capturedAt !== productionControls.runtime.immutableClosure.functionalRehearsalCapturedAt) {
    throw new Error("Pilot packet runtime evidence differs from the production-controls closure");
  }
  if (!verified?.meta?.pulledAt || !Number.isFinite(Date.parse(verified.meta.pulledAt))) {
    throw new Error("Pilot packet requires valid live-flow pull metadata");
  }
  if (!/^[a-f0-9]{64}$/.test(String(verified.meta.sourceSha256 || ""))
    || !Number.isInteger(verified.meta.nodeCount)
    || verified.meta.nodeCount < 1) {
    throw new Error("Pilot packet requires exact shared Node-RED read-back identity");
  }
  return {
    formatVersion: 1,
    pilotVersion: "0.2.0",
    deploymentId: DEPLOYMENT_ID,
    repository,
    topology: "DEDICATED_LOOPBACK_SIDECAR",
    sidecarPort: 18894,
    sidecarClosure: { ...productionControls.runtime.sidecar },
    sharedNodeRedFlowMutationAllowed: false,
    livePulledAt: verified.meta.pulledAt,
    liveReadbackSha256: verified.meta.sourceSha256,
    liveReadbackNodeCount: verified.meta.nodeCount,
    sourceSha256: contract.sourceSha256,
    candidateSha256: contract.candidateSha256,
    sourceNodeCount: contract.sourceNodeCount,
    candidateNodeCount: contract.candidateNodeCount,
    httpInputCount: contract.httpInputCount,
    changedNodeCount: contract.allowedChanges.length,
    addedNodeCount: contract.allowedAdditions.length,
    customNodeReleaseSha256: release.releaseSha256,
    runtimeManifestSha256: runtimeEvidence.manifestSha256,
    functionalRehearsalScope: runtimeEvidence.functionalRehearsal.evidenceScope,
    productionControlsSha256,
    productionControlsState: productionControls.contractState,
    runtimeSecurityState: productionControls.runtime.state,
    productionCustodyState: productionControls.custody.state,
    vivaContractState: "AWAITING_EXTERNAL_CONFIRMATION",
    ingressState: productionControls.ingress.state,
    activationState: productionControls.activation.state,
    liveMutationAuthorized: false,
    deploymentPerformed: false,
    activationPerformed: false,
    requiredBeforeDeploy: [
      "fresh shared Node-RED live flow read-back still matches liveReadbackSha256 and contains no Partner route or node-id collision",
      "checkpoint is integrated into clean pushed main with green exact-head CI",
      "dedicated Partner sidecar is installed from the exact Node-RED runtime closure and binds only to 127.0.0.1:18894",
      "shared production Node-RED on 127.0.0.1:1880 and its live flow remain byte-for-byte untouched",
      "the isolated functional rehearsal proves dedicated-sidecar custom-node load, default-off behavior, and removal; the exact sidecar candidate requires deploy-stage read-back",
      "the dedicated sidecar runtime audit satisfies production-controls policy without inheriting the shared production palette closure",
      "private sidecar flow backup, exact rollback artifacts, service stop/restart procedure, and lease paths are verified",
      "dedicated unprivileged service account, root-owned /opt release path, writable /var/lib state path, and exact systemd unit are separately authorized and provisioned",
      "Mongo replica-set transactions and every exact required index are rehearsed on a disposable database",
      "Viva confirms Idempotency-Key semantics, create/read/cancel payloads, ON_PLACE behavior, and technical-client multiplicity",
      "dedicated ingress is bound with TLS, mandatory mTLS, optional exact CIDR, rate limits, body limits, and socket-peer proxy-chain validation",
      "Partner ingress exposes only the three exact routes, strips upstream CORS, rejects duplicate proof headers, and exposes no editor/admin surface",
      "server-only signing keys, audit HMAC key, Mongo URI, technical client ID, and Viva token custody are provisioned without disclosure",
      "dedicated sidecar Viva access-token acquisition, refresh, revocation, and least-privilege service identity are confirmed without shared Node-RED global context",
      "secret-bearing packet custody has named recipients, encrypted transport, root-only destination, retention, deletion, and incident owners",
      "security, reliability, compatibility, and recovery evidence contains no UNKNOWN or failed gate",
    ],
    requiredBeforeActivation: [
      "LK_PARTNER_GAME_API_ENABLED remains false during deploy and post-install verification",
      "provider mode remains disabled until a separately authorized canary",
      "all four Viva mutation gates are set only after written provider confirmation",
      "canary client scope and station allowlist are least privilege and independently reviewed",
      "reconciliation and UNKNOWN-operation runbooks are staffed before the first request",
    ],
    rollback: {
      deploymentId: DEPLOYMENT_ID,
      sourceSha256: contract.sourceSha256,
      candidateSha256: contract.candidateSha256,
      exactByteRollbackRehearsed: rollbackRehearsed === true,
      sharedNodeRedFlowMutationRequired: false,
      sidecarStopAndRouteRemovalRequired: true,
      nodeRedRestartRehearsed: false,
      productionRollbackPerformed: false,
    },
  };
}

function buildCustomNodeRelease() {
  const files = RELEASE_FILES.map((relativePath) => {
    const absolutePath = path.join(NODE_PACKAGE_ROOT, relativePath);
    const stat = fs.lstatSync(absolutePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new Error(`Custom-node release file is not a private regular source file: ${relativePath}`);
    }
    const bytes = fs.readFileSync(absolutePath);
    return { relativePath, bytes, sha256: sha256(bytes), size: bytes.length };
  });
  const packageJson = JSON.parse(files.find(({ relativePath }) => relativePath === "package.json").bytes.toString("utf8"));
  const packageLock = JSON.parse(files.find(({ relativePath }) => relativePath === "package-lock.json").bytes.toString("utf8"));
  if (
    packageJson.name !== "@padlhub/node-red-partner-game-membership-api"
    || packageJson.version !== "0.2.0"
    || !isDeepStrictEqual(packageJson.dependencies, { mongodb: "7.2.0" })
    || packageJson.scripts !== undefined
    || packageLock.lockfileVersion !== 3
    || packageLock.name !== packageJson.name
    || packageLock.version !== packageJson.version
    || !isDeepStrictEqual(packageLock.packages?.[""]?.dependencies, packageJson.dependencies)
    || packageLock.packages?.["node_modules/mongodb"]?.version !== "7.2.0"
  ) throw new Error("Custom-node package identity differs from pilot v0.2");
  const identity = files.map(({ relativePath, sha256: digest, size }) => ({ relativePath, sha256: digest, size }));
  return {
    files,
    manifest: {
      formatVersion: 1,
      packageName: "@padlhub/node-red-partner-game-membership-api",
      packageVersion: "0.2.0",
      files: identity,
      releaseSha256: sha256(Buffer.from(JSON.stringify(identity), "utf8")),
      installPerformed: false,
      activationPerformed: false,
    },
  };
}

export function preparePartnerV02Packet({
  workspace,
  outDir,
  repository: suppliedRepository,
  testHooks,
} = {}) {
  const repository = validateRepositoryIdentity(suppliedRepository || repositoryIdentity());
  const verified = verifyWorkspace(workspace, { quiet: true });
  const output = assertExternalNewPacketDirectory(outDir);
  buildPartnerGameMembershipApiCandidate(verified.source);
  const result = buildPartnerGameMembershipApiSidecarCandidate();
  const liveBytes = Buffer.from(`${JSON.stringify(result.sourceFlow, null, 2)}\n`, "utf8");
  const candidateBytes = Buffer.from(`${JSON.stringify(result.flow, null, 2)}\n`, "utf8");
  const expectedAdditions = Object.values(PARTNER_API_FLOW_NODE_IDS).sort();
  if (!isDeepStrictEqual([...result.addedNodeIds].sort(), expectedAdditions)) {
    throw new Error("Pilot candidate differs from the exact partner API addition allowlist");
  }
  const contract = buildExactGraphContract({
    liveBytes,
    candidateBytes,
    deploymentId: DEPLOYMENT_ID,
    allowedChanges: [],
    allowedAdditionIds: expectedAdditions,
  });
  validateExactGraphContract({ liveBytes, candidateBytes, contract });
  const release = buildCustomNodeRelease();
  const runtimeEvidence = validateCheckedPartnerRuntimeEvidence();
  const productionControlsBytes = fs.readFileSync(PRODUCTION_CONTROLS_PATH);
  const productionControls = JSON.parse(productionControlsBytes.toString("utf8"));
  validatePartnerProductionControls(productionControls);
  const productionControlsSha256 = sha256(productionControlsBytes);
  const sidecarArtifacts = Object.fromEntries(SIDECAR_TEMPLATE_FILES.map((relativePath) => [
    relativePath,
    fs.readFileSync(path.join(SIDECAR_TEMPLATE_ROOT, relativePath)),
  ]));
  validatePartnerSidecarArtifacts({
    artifacts: sidecarArtifacts,
    candidateBytes,
    sidecarControls: productionControls.runtime.sidecar,
  });
  const rollbackRehearsed = rehearseExactByteRollback({ liveBytes, candidateBytes, contract });
  const plan = buildPartnerV02DeploymentPlan({
    repository,
    verified,
    contract,
    release: release.manifest,
    rollbackRehearsed,
    productionControls,
    productionControlsBytes,
    productionControlsSha256,
    runtimeEvidence,
  });

  const parent = path.dirname(output);
  const temporaryPrefix = path.join(parent, `.${path.basename(output)}.tmp-`);
  const temporaryOutput = fs.mkdtempSync(temporaryPrefix);
  let published = false;
  try {
    fs.chmodSync(temporaryOutput, 0o700);
    const packageOutput = path.join(temporaryOutput, "custom-node");
    const runtimeOutput = path.join(temporaryOutput, "runtime");
    const runtimePackageOutput = path.join(runtimeOutput, "partner-package");
    const sidecarOutput = path.join(temporaryOutput, "sidecar");
    fs.mkdirSync(packageOutput, { mode: 0o700 });
    fs.mkdirSync(runtimePackageOutput, { recursive: true, mode: 0o700 });
    fs.mkdirSync(sidecarOutput, { mode: 0o700 });
    fs.chmodSync(packageOutput, 0o700);
    fs.chmodSync(runtimeOutput, 0o700);
    fs.chmodSync(runtimePackageOutput, 0o700);
    fs.chmodSync(sidecarOutput, 0o700);
    writePrivateBytes(path.join(temporaryOutput, "source.flow.json"), liveBytes);
    writePrivateBytes(path.join(temporaryOutput, "candidate.flow.json"), candidateBytes);
    writePrivateJson(path.join(temporaryOutput, "reviewed-flow.contract.json"), contract);
    writePrivateJson(path.join(temporaryOutput, "custom-node.release.json"), release.manifest);
    writePrivateBytes(path.join(temporaryOutput, "production-controls.contract.json"), productionControlsBytes);
    writePrivateJson(path.join(temporaryOutput, "deployment-plan.json"), plan);
    for (const file of release.files) {
      writePrivateBytes(path.join(packageOutput, file.relativePath), file.bytes);
      writePrivateBytes(path.join(runtimePackageOutput, file.relativePath), file.bytes);
    }
    for (const relativePath of RUNTIME_ARTIFACT_FILES) {
      const bytes = runtimeEvidence.artifactBytes[relativePath];
      if (!Buffer.isBuffer(bytes)) throw new Error(`Pilot packet lacks validated runtime bytes: ${relativePath}`);
      writePrivateBytes(path.join(runtimeOutput, relativePath), bytes);
    }
    for (const relativePath of SIDECAR_TEMPLATE_FILES) {
      writePrivateBytes(path.join(sidecarOutput, relativePath), sidecarArtifacts[relativePath]);
    }
    const copiedRuntimeEvidence = validatePartnerRuntimeEvidence({
      manifestBytes: fs.readFileSync(path.join(runtimeOutput, "runtime-manifest.json")),
      packageJsonBytes: fs.readFileSync(path.join(runtimeOutput, "package.json")),
      packageLockBytes: fs.readFileSync(path.join(runtimeOutput, "package-lock.json")),
      dependencyTreeBytes: fs.readFileSync(path.join(runtimeOutput, "dependency-tree.json")),
      auditReportBytes: fs.readFileSync(path.join(runtimeOutput, "audit-report.json")),
      functionalRehearsalBytes: fs.readFileSync(path.join(runtimeOutput, "functional-rehearsal.json")),
      customReleaseSha256: release.manifest.releaseSha256,
    });
    if (copiedRuntimeEvidence.manifestSha256 !== runtimeEvidence.manifestSha256) {
      throw new Error("Pilot packet runtime snapshot changed after validation");
    }
    syncDirectory(packageOutput);
    syncDirectory(runtimePackageOutput);
    syncDirectory(runtimeOutput);
    syncDirectory(sidecarOutput);
    const packetManifest = buildPacketManifest({ output: temporaryOutput, repository, plan });
    writePrivateJson(path.join(temporaryOutput, "packet.manifest.json"), packetManifest);
    syncDirectory(temporaryOutput);
    if (!suppliedRepository && !isDeepStrictEqual(repositoryIdentity(), repository)) {
      throw new Error("Pilot packet repository identity changed during generation");
    }
    if (testHooks?.beforeAtomicPublish) testHooks.beforeAtomicPublish({ temporaryOutput, output });
    fs.renameSync(temporaryOutput, output);
    published = true;
    syncDirectory(parent);
    return {
      output,
      plan,
      contract,
      release: release.manifest,
      productionControls,
      runtimeEvidence,
      packetManifest,
    };
  } catch (error) {
    fs.rmSync(published ? output : temporaryOutput, { recursive: true, force: true });
    try { syncDirectory(parent); } catch { /* preserve the original generation failure */ }
    throw error;
  }
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) args[argv[index]] = argv[index + 1];
  if (!args["--workspace"] || !args["--out"]) {
    throw new Error("Usage: --workspace /absolute/fresh-live-workspace --out /absolute/new-private-packet");
  }
  return args;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = preparePartnerV02Packet({ workspace: args["--workspace"], outDir: args["--out"] });
    process.stdout.write(`${JSON.stringify({
      packetDirectory: result.output,
      topology: result.plan.topology,
      sidecarPort: result.plan.sidecarPort,
      liveReadbackSha256: result.plan.liveReadbackSha256,
      liveReadbackNodeCount: result.plan.liveReadbackNodeCount,
      sourceSha256: result.plan.sourceSha256,
      candidateSha256: result.plan.candidateSha256,
      customNodeReleaseSha256: result.plan.customNodeReleaseSha256,
      addedNodeCount: result.plan.addedNodeCount,
      liveMutationAuthorized: result.plan.liveMutationAuthorized,
      deploymentPerformed: result.plan.deploymentPerformed,
      activationPerformed: result.plan.activationPerformed,
    })}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
