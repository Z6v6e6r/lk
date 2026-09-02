#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { verifyWorkspace } from "./verify_nodered_source_origin.mjs";
import {
  buildUnifiedLk1EnforcementCandidate,
  LK1_ENFORCEMENT_CONTRACT,
} from "./prepare_lk1_subscription_enforcement_candidate.mjs";
import { LK1_SUBSCRIPTION_ENFORCEMENT_ACTIVATION_MANIFEST } from "./lk1_subscription_enforcement_activation_manifest.mjs";
import {
  buildExactGraphContract,
  sha256,
  syncDirectory,
  validateExactGraphContract,
} from "./nodered_reviewed_flow_deploy/runtime_contract.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = fs.realpathSync(path.resolve(SCRIPT_DIR, ".."));
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;

const normalizedChanges = (changes) => changes
  .map((change) => ({ id: change.id, fields: [...change.fields].sort() }))
  .sort((left, right) => left.id.localeCompare(right.id));

export function validateActivationManifest(
  manifest = LK1_SUBSCRIPTION_ENFORCEMENT_ACTIVATION_MANIFEST,
  enforcementContract = LK1_ENFORCEMENT_CONTRACT,
) {
  if (!manifest || manifest.formatVersion !== 1) throw new Error("Activation manifest version mismatch");
  if (enforcementContract.candidateBindingState !== "BOUND"
    || !/^[a-f0-9]{64}$/.test(enforcementContract.candidateSha256 || "")) {
    throw new Error("Activation enforcement contract is unbound after router amendment");
  }
  const changes = normalizedChanges(manifest.allowedChanges || []);
  const additions = [...(manifest.allowedAdditionIds || [])].sort();
  if (
    manifest.sourceSha256 !== enforcementContract.sourceSha256
    || manifest.candidateSha256 !== enforcementContract.candidateSha256
    || manifest.sourceNodeCount !== enforcementContract.nodeCount
    || manifest.candidateNodeCount !== enforcementContract.candidateNodeCount
    || manifest.httpInputCount !== enforcementContract.httpRouteCount
    || manifest.changedNodeCount !== enforcementContract.changedExistingNodeCount
    || manifest.addedNodeCount !== enforcementContract.addedNodeCount
    || changes.length !== manifest.changedNodeCount
    || additions.length !== manifest.addedNodeCount
    || new Set(changes.map(({ id }) => id)).size !== changes.length
    || new Set(additions).size !== additions.length
    || changes.some(({ id }) => additions.includes(id))
  ) throw new Error("Activation manifest identity or change budget mismatch");
  return { changes, additions };
}

export function buildReviewedActivationContract({
  liveBytes,
  candidateBytes,
  manifest = LK1_SUBSCRIPTION_ENFORCEMENT_ACTIVATION_MANIFEST,
  enforcementContract = LK1_ENFORCEMENT_CONTRACT,
} = {}) {
  const { changes, additions } = validateActivationManifest(manifest, enforcementContract);
  if (sha256(liveBytes) !== manifest.sourceSha256) throw new Error("Activation live-flow digest mismatch");
  if (sha256(candidateBytes) !== manifest.candidateSha256) throw new Error("Activation candidate digest mismatch");
  const contract = buildExactGraphContract({
    liveBytes,
    candidateBytes,
    deploymentId: manifest.deploymentId,
    allowedChanges: changes,
    allowedAdditionIds: additions,
  });
  validateExactGraphContract({ liveBytes, candidateBytes, contract });
  if (
    contract.sourceNodeCount !== manifest.sourceNodeCount
    || contract.candidateNodeCount !== manifest.candidateNodeCount
    || contract.httpInputCount !== manifest.httpInputCount
    || contract.allowedChanges.length !== manifest.changedNodeCount
    || contract.allowedAdditions.length !== manifest.addedNodeCount
  ) throw new Error("Activation exact-graph contract inventory mismatch");
  return contract;
}

function repositoryIdentity() {
  const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" });
  const branch = spawnSync("git", ["branch", "--show-current"], { cwd: REPO_ROOT, encoding: "utf8" });
  const status = spawnSync("git", ["status", "--porcelain"], { cwd: REPO_ROOT, encoding: "utf8" });
  const commit = revision.status === 0 ? revision.stdout.trim() : "";
  if (!COMMIT_PATTERN.test(commit) || branch.status !== 0 || !branch.stdout.trim()) {
    throw new Error("Activation packet requires an exact task-branch commit");
  }
  if (status.status !== 0 || status.stdout.trim()) throw new Error("Activation packet requires a clean worktree");
  return { commit, branch: branch.stdout.trim() };
}

export function assertExternalNewDirectory(outArg) {
  if (!outArg || !path.isAbsolute(outArg)) throw new Error("Activation packet output must be absolute");
  const output = path.resolve(outArg);
  const parent = path.dirname(output);
  const parentStat = fs.lstatSync(parent);
  const canonicalParent = fs.realpathSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || canonicalParent !== parent) {
    throw new Error("Activation packet output parent must be a real canonical directory");
  }
  const canonicalOutput = path.join(canonicalParent, path.basename(output));
  const relative = path.relative(REPO_ROOT, canonicalOutput);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw new Error("Activation packet output must be outside the repository");
  }
  if (fs.existsSync(canonicalOutput)) {
    throw new Error("Activation packet output must be a new path under a real parent");
  }
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

export function buildActivationPlan({
  manifest = LK1_SUBSCRIPTION_ENFORCEMENT_ACTIVATION_MANIFEST,
  repository,
  livePulledAt,
} = {}) {
  validateActivationManifest(manifest);
  if (
    !repository
    || !COMMIT_PATTERN.test(String(repository.commit || ""))
    || typeof repository.branch !== "string"
    || !repository.branch.trim()
  ) throw new Error("Activation plan requires an exact task-branch identity");
  if (!Number.isFinite(Date.parse(livePulledAt))) throw new Error("Activation plan requires a valid live pull time");
  return {
    formatVersion: 1,
    deploymentId: manifest.deploymentId,
    repository,
    livePulledAt,
    sourceSha256: manifest.sourceSha256,
    candidateSha256: manifest.candidateSha256,
    sourceNodeCount: manifest.sourceNodeCount,
    candidateNodeCount: manifest.candidateNodeCount,
    httpInputCount: manifest.httpInputCount,
    changedNodeCount: manifest.changedNodeCount,
    addedNodeCount: manifest.addedNodeCount,
    productionCustodyState: "UNBOUND",
    liveMutationAuthorized: false,
    deploymentPerformed: false,
    requiredBeforeDeploy: [
      "fresh live flow still matches sourceSha256",
      "exact checkpoint is integrated into clean pushed main with green exact-head CI",
      "production approval trust anchor and custodian release attestation are bound",
      "legacy command custom-node package and database prerequisites pass separately approved audit/dry-run/postcheck gates",
      "subscriptions runtime URL, context token and activation token are provisioned without disclosure",
      "immediate private flow backup and exact reviewed-flow contract backup paths are reserved",
      "global reviewed-flow lock is free and no foreign active lease exists",
    ],
    rollback: {
      deploymentId: manifest.deploymentId,
      sourceSha256: manifest.sourceSha256,
      candidateSha256: manifest.candidateSha256,
      requiresExactFlowAndContractBackups: true,
      rehearsedAgainstIsolatedCopy: false,
      productionRollbackPerformed: false,
    },
  };
}

export function prepareActivationPacket({ workspace, outDir } = {}) {
  const repository = repositoryIdentity();
  const verified = verifyWorkspace(workspace, { quiet: true });
  const output = assertExternalNewDirectory(outDir);
  const result = buildUnifiedLk1EnforcementCandidate(verified.source, verified.sourceSha256);
  const candidateBytes = Buffer.from(`${JSON.stringify(result.candidate, null, 2)}\n`, "utf8");
  const liveBytes = fs.readFileSync(verified.sourcePath);
  const manifest = LK1_SUBSCRIPTION_ENFORCEMENT_ACTIVATION_MANIFEST;
  const expectedChanges = normalizedChanges(manifest.allowedChanges);
  const actualChanges = normalizedChanges(result.changedNodes
    .filter(({ kind }) => kind === "changed")
    .map(({ id, changedFields }) => ({ id, fields: changedFields })));
  const actualAdditions = result.changedNodes
    .filter(({ kind }) => kind === "added")
    .map(({ id }) => id)
    .sort();
  if (
    !isDeepStrictEqual(actualChanges, expectedChanges)
    || !isDeepStrictEqual(actualAdditions, [...manifest.allowedAdditionIds].sort())
  ) throw new Error("Activation candidate differs from the reviewed node allowlist");
  const contract = buildReviewedActivationContract({ liveBytes, candidateBytes, manifest });
  const plan = buildActivationPlan({ manifest, repository, livePulledAt: verified.meta.pulledAt });
  fs.mkdirSync(output, { mode: 0o700 });
  try {
    fs.chmodSync(output, 0o700);
    const outputStat = fs.lstatSync(output);
    if (
      !outputStat.isDirectory()
      || outputStat.isSymbolicLink()
      || fs.realpathSync(output) !== output
      || (outputStat.mode & 0o777) !== 0o700
    ) throw new Error("Activation packet output directory contract mismatch");
    syncDirectory(path.dirname(output));
    writePrivateBytes(path.join(output, "candidate.flow.json"), candidateBytes);
    writePrivateJson(path.join(output, "reviewed-flow.contract.json"), contract);
    writePrivateJson(path.join(output, "activation-plan.json"), plan);
    syncDirectory(output);
    const finalRepository = repositoryIdentity();
    if (!isDeepStrictEqual(finalRepository, repository)) {
      throw new Error("Activation packet repository identity changed during generation");
    }
  } catch (error) {
    fs.rmSync(output, { recursive: true, force: true });
    throw error;
  }
  return { output, plan, contract };
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
    const result = prepareActivationPacket({ workspace: args["--workspace"], outDir: args["--out"] });
    process.stdout.write(`${JSON.stringify({
      packetDirectory: result.output,
      sourceSha256: result.plan.sourceSha256,
      candidateSha256: result.plan.candidateSha256,
      changedNodeCount: result.plan.changedNodeCount,
      addedNodeCount: result.plan.addedNodeCount,
      liveMutationAuthorized: result.plan.liveMutationAuthorized,
      deploymentPerformed: result.plan.deploymentPerformed,
    })}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
