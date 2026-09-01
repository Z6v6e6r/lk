#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { buildPartnerGameMembershipApiCandidate, PARTNER_API_FLOW_NODE_IDS } from "./patch_partner_game_membership_api_flow.mjs";
import { verifyWorkspace } from "./verify_nodered_source_origin.mjs";
import {
  buildExactGraphContract,
  sha256,
  syncDirectory,
  validateExactGraphContract,
} from "./nodered_reviewed_flow_deploy/runtime_contract.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = fs.realpathSync(path.resolve(SCRIPT_DIR, ".."));
const NODE_PACKAGE_ROOT = path.join(REPO_ROOT, "node-red/custom-nodes/partner-game-membership-api");
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

const isWithin = (parent, candidate) => {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

function repositoryIdentity() {
  const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" });
  const branch = spawnSync("git", ["branch", "--show-current"], { cwd: REPO_ROOT, encoding: "utf8" });
  const status = spawnSync("git", ["status", "--porcelain"], { cwd: REPO_ROOT, encoding: "utf8" });
  const repository = { commit: revision.stdout.trim(), branch: branch.stdout.trim() };
  if (revision.status !== 0 || branch.status !== 0 || !COMMIT_PATTERN.test(repository.commit) || !repository.branch) {
    throw new Error("Pilot packet requires an exact task-branch commit");
  }
  if (status.status !== 0 || status.stdout.trim()) throw new Error("Pilot packet requires a clean worktree");
  return repository;
}

function validateRepositoryIdentity(repository) {
  if (!repository || !COMMIT_PATTERN.test(String(repository.commit || "")) || !String(repository.branch || "").trim()) {
    throw new Error("Pilot packet requires an exact repository identity");
  }
  return { commit: repository.commit, branch: repository.branch.trim() };
}

export function assertExternalNewPacketDirectory(outArg) {
  if (!outArg || !path.isAbsolute(outArg)) throw new Error("Pilot packet output must be absolute");
  const output = path.resolve(outArg);
  const parent = path.dirname(output);
  const stat = fs.lstatSync(parent);
  const canonicalParent = fs.realpathSync(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink() || canonicalParent !== parent) {
    throw new Error("Pilot packet parent must be a real canonical directory");
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

export function buildPartnerV02DeploymentPlan({ repository, verified, contract, release, rollbackRehearsed }) {
  validateRepositoryIdentity(repository);
  if (!verified?.meta?.pulledAt || !Number.isFinite(Date.parse(verified.meta.pulledAt))) {
    throw new Error("Pilot packet requires valid live-flow pull metadata");
  }
  return {
    formatVersion: 1,
    pilotVersion: "0.2.0",
    deploymentId: DEPLOYMENT_ID,
    repository,
    livePulledAt: verified.meta.pulledAt,
    sourceSha256: contract.sourceSha256,
    candidateSha256: contract.candidateSha256,
    sourceNodeCount: contract.sourceNodeCount,
    candidateNodeCount: contract.candidateNodeCount,
    httpInputCount: contract.httpInputCount,
    changedNodeCount: contract.allowedChanges.length,
    addedNodeCount: contract.allowedAdditions.length,
    customNodeReleaseSha256: release.releaseSha256,
    productionCustodyState: "UNBOUND",
    vivaContractState: "AWAITING_EXTERNAL_CONFIRMATION",
    ingressState: "UNBOUND",
    liveMutationAuthorized: false,
    deploymentPerformed: false,
    activationPerformed: false,
    requiredBeforeDeploy: [
      "fresh live flow still matches sourceSha256 and the exact LK Games origin",
      "checkpoint is integrated into clean pushed main with green exact-head CI",
      "custom-node package installation and Node-RED load/unload are rehearsed on an isolated compatible runtime",
      "private flow backup, exact rollback artifacts, global deployment lock, and lease paths are verified",
      "Mongo replica-set transactions and every exact required index are rehearsed on a disposable database",
      "Viva confirms Idempotency-Key semantics, create/read/cancel payloads, ON_PLACE behavior, and technical-client multiplicity",
      "dedicated ingress is bound with TLS, M2M allowlist or mTLS, rate limits, body limits, and proxy-chain validation",
      "server-only signing keys, audit HMAC key, Mongo URI, technical client ID, and Viva token custody are provisioned without disclosure",
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

export function preparePartnerV02Packet({ workspace, outDir, repository: suppliedRepository } = {}) {
  const repository = validateRepositoryIdentity(suppliedRepository || repositoryIdentity());
  const verified = verifyWorkspace(workspace, { quiet: true });
  const output = assertExternalNewPacketDirectory(outDir);
  const result = buildPartnerGameMembershipApiCandidate(verified.source);
  const liveBytes = fs.readFileSync(verified.sourcePath);
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
  const rollbackRehearsed = rehearseExactByteRollback({ liveBytes, candidateBytes, contract });
  const plan = buildPartnerV02DeploymentPlan({
    repository,
    verified,
    contract,
    release: release.manifest,
    rollbackRehearsed,
  });

  fs.mkdirSync(output, { mode: 0o700 });
  try {
    fs.chmodSync(output, 0o700);
    const packageOutput = path.join(output, "custom-node");
    fs.mkdirSync(packageOutput, { mode: 0o700 });
    fs.chmodSync(packageOutput, 0o700);
    syncDirectory(path.dirname(output));
    writePrivateBytes(path.join(output, "candidate.flow.json"), candidateBytes);
    writePrivateJson(path.join(output, "reviewed-flow.contract.json"), contract);
    writePrivateJson(path.join(output, "custom-node.release.json"), release.manifest);
    writePrivateJson(path.join(output, "deployment-plan.json"), plan);
    for (const file of release.files) writePrivateBytes(path.join(packageOutput, file.relativePath), file.bytes);
    syncDirectory(packageOutput);
    syncDirectory(output);
    if (!suppliedRepository && !isDeepStrictEqual(repositoryIdentity(), repository)) {
      throw new Error("Pilot packet repository identity changed during generation");
    }
  } catch (error) {
    fs.rmSync(output, { recursive: true, force: true });
    throw error;
  }
  return { output, plan, contract, release: release.manifest };
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
