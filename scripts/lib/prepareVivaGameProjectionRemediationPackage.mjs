#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { canonicalJson, sha256 } from "./vivaGameProjectionCutoverContract.mjs";
import {
  REMEDIATION_RUNTIME_PACKAGE_NAMES,
  REMEDIATION_EXECUTOR_SOURCE_PATHS,
  validateExecutableRemediationPlan,
} from "./vivaGameProjectionRemediationExecution.mjs";
import {
  buildRemediationExecutionPlan,
  validateRemediationExecutionIndex,
} from "./vivaGameProjectionRemediationPackage.mjs";
import { syncDirectory } from "../nodered_reviewed_flow_deploy/runtime_contract.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = fs.realpathSync(path.resolve(path.dirname(SCRIPT_PATH), "../.."));
const COMMIT_RE = /^[a-f0-9]{40}$/;
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const MAX_BACKUP_BYTES = 1024 * 1024 * 1024;
const GIT_ENV = Object.freeze({
  PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
  LANG: "C",
  LC_ALL: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_OPTIONAL_LOCKS: "0",
});
const INPUTS = Object.freeze({
  cutoverPlan: ["--cutover-plan", "cutover-plan.json", MAX_JSON_BYTES, true],
  migrationPlanBundle: ["--migration-plan-bundle", "migration-plan-bundle.json", MAX_JSON_BYTES, true],
  packet: ["--packet", "remediation-review.packet.json", MAX_JSON_BYTES, true],
  enrichment: ["--enrichment", "remediation-manual-review.json", MAX_JSON_BYTES, true],
  identityAudit: ["--identity-audit", "identity-reference-audit.json", MAX_JSON_BYTES, true],
  providerCapture: ["--provider-capture", "provider.capture.json", MAX_JSON_BYTES, true],
  mongoCapture: ["--mongo-capture", "mongo.capture.json", MAX_JSON_BYTES, true],
  fullBackup: ["--full-backup", "full-backup.ejson", MAX_BACKUP_BYTES, false],
  fullBackupManifest: ["--full-backup-manifest", "full-backup.manifest.json", MAX_JSON_BYTES, true],
  restoreRehearsalReceipt: ["--restore-rehearsal-receipt", "restore-rehearsal.receipt.json", MAX_JSON_BYTES, true],
  restoredArtifact: ["--restored-artifact", "full-backup.restored.ejson", MAX_BACKUP_BYTES, false],
  fenceReceipt: ["--fence-receipt", "writer-fence.receipt.json", MAX_JSON_BYTES, true],
  mongoWriteBarrierReceipt: ["--mongo-write-barrier-receipt", "mongo-write-barrier.receipt.json", MAX_JSON_BYTES, true],
  migrationConnectionFile: ["--migration-connection-file", "migration-mongo.connection.json", MAX_JSON_BYTES, true],
  flow: ["--flow-path", "source.flow.json", 256 * 1024 * 1024, true],
});

const fail = (message) => { throw new Error(message); };
const safeGit = (repoRoot, args, encoding = "utf8") => spawnSync("/usr/bin/git", [
  "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args,
], {
  cwd: repoRoot,
  encoding,
  env: GIT_ENV,
  maxBuffer: 32 * 1024 * 1024,
});

function readPrivateFile(filePath, label, maximumSize) {
  if (!path.isAbsolute(String(filePath || ""))) fail(`${label} path must be absolute`);
  const requested = path.resolve(filePath);
  if (fs.realpathSync(requested) !== requested) fail(`${label} path must be canonical`);
  const descriptor = fs.openSync(requested, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    const currentUid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== currentUid || (stat.mode & 0o077) !== 0
      || stat.size < 1 || stat.size > maximumSize) {
      fail(`${label} must be an owned private single-link regular file`);
    }
    return fs.readFileSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function jsonArtifact(filePath, label, maximumSize) {
  const bytes = readPrivateFile(filePath, label, maximumSize);
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { fail(`${label} must contain valid JSON`); }
  return { bytes, value };
}

function currentRepository(expectedRepository, repoRoot = REPO_ROOT) {
  const head = safeGit(repoRoot, ["rev-parse", "HEAD"]);
  const branchRead = safeGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const status = safeGit(repoRoot, ["status", "--porcelain"]);
  const commit = head.stdout.trim();
  const branch = branchRead.stdout.trim();
  if (head.status !== 0 || branchRead.status !== 0 || status.status !== 0 || status.stdout.trim()
    || !COMMIT_RE.test(commit) || !branch.startsWith("codex/")
    || (expectedRepository && (commit !== expectedRepository.commit || branch !== expectedRepository.branch))) {
    fail("Remediation package requires the exact clean cutover task-branch commit");
  }
  return { commit, branch };
}

function executorSourceManifest(repositoryCommit, repoRoot = REPO_ROOT) {
  return REMEDIATION_EXECUTOR_SOURCE_PATHS.map((relativePath) => {
    const absolutePath = path.join(repoRoot, relativePath);
    const bytes = fs.readFileSync(absolutePath);
    const committed = safeGit(repoRoot, ["show", `${repositoryCommit}:${relativePath}`], null);
    if (committed.status !== 0 || !Buffer.isBuffer(committed.stdout) || !committed.stdout.equals(bytes)) {
      fail(`Remediation executor source is not the exact committed byte stream: ${relativePath}`);
    }
    return { path: relativePath, sha256: sha256(bytes) };
  });
}

function assertCommittedExecutorSources(plan, repoRoot = REPO_ROOT) {
  if (!COMMIT_RE.test(String(plan?.repository?.commit || "")) || !Array.isArray(plan?.executorSources)) {
    fail("Remediation cutover plan lacks committed executor identity");
  }
  for (const entry of plan.executorSources) {
    if (!entry?.path || !/^[a-f0-9]{64}$/.test(String(entry.sha256 || ""))
      || sha256(committedRepositoryBytes(repoRoot, plan.repository.commit, entry.path)) !== entry.sha256) {
      fail("Remediation cutover plan executor differs from its exact committed source");
    }
  }
}

const committedRepositoryBytes = (repoRoot, repositoryCommit, relativePath) => {
  const committed = safeGit(repoRoot, ["show", `${repositoryCommit}:${relativePath}`], null);
  if (committed.status !== 0 || !Buffer.isBuffer(committed.stdout)) {
    fail(`Remediation runtime cannot read committed ${relativePath}`);
  }
  return committed.stdout;
};

export function collectInstalledRuntimeDependencies(installRoot, packageJsonBytes, packageLockBytes) {
  let packageLock;
  try { packageLock = JSON.parse(packageLockBytes.toString("utf8")); }
  catch { fail("Remediation runtime package lock is not valid JSON"); }
  const packages = REMEDIATION_RUNTIME_PACKAGE_NAMES.map((name) => {
    const locked = packageLock?.packages?.[`node_modules/${name}`];
    if (!locked?.version || !locked?.integrity) fail(`Remediation runtime package is absent from package-lock: ${name}`);
    return { name, version: locked.version, integrity: locked.integrity };
  });
  const requestedNodeModules = path.join(installRoot, "node_modules");
  const nodeModules = fs.realpathSync(requestedNodeModules);
  const nodeModulesStat = fs.lstatSync(requestedNodeModules);
  const uid = typeof process.getuid === "function" ? process.getuid() : nodeModulesStat.uid;
  if (nodeModules !== requestedNodeModules || !nodeModulesStat.isDirectory() || nodeModulesStat.isSymbolicLink()
    || nodeModulesStat.uid !== uid || (nodeModulesStat.mode & 0o022) !== 0) {
    fail("Remediation runtime dependencies require canonical owned non-writable node_modules");
  }
  const files = [];
  const visit = (absoluteDirectory) => {
    const directoryStat = fs.lstatSync(absoluteDirectory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()
      || directoryStat.uid !== uid || (directoryStat.mode & 0o022) !== 0
      || fs.realpathSync(absoluteDirectory) !== absoluteDirectory) {
      fail("Remediation runtime dependency directory is unsafe");
    }
    for (const entry of fs.readdirSync(absoluteDirectory, { withFileTypes: true })) {
      const absolutePath = path.join(absoluteDirectory, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      const descriptor = fs.openSync(absolutePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const stat = fs.fstatSync(descriptor);
        if (!entry.isFile() || !stat.isFile() || stat.nlink !== 1 || stat.uid !== uid || (stat.mode & 0o022) !== 0) {
          fail("Remediation runtime dependency file is unsafe");
        }
        const bytes = fs.readFileSync(descriptor);
        files.push({
          path: path.relative(installRoot, absolutePath),
          size: bytes.length,
          sha256: sha256(bytes),
          bytesBase64: bytes.toString("base64"),
        });
      } finally {
        fs.closeSync(descriptor);
      }
    }
  };
  for (const name of REMEDIATION_RUNTIME_PACKAGE_NAMES) visit(path.join(nodeModules, name));
  files.sort((left, right) => left.path.localeCompare(right.path));
  return {
    formatVersion: 1,
    kind: "viva-game-projection-runtime-dependency-snapshot",
    installMethod: "fresh-private-npm-ci-ignore-scripts-omit-dev",
    packageJsonSha256: sha256(packageJsonBytes),
    packageJsonBytesBase64: packageJsonBytes.toString("base64"),
    packageLockSha256: sha256(packageLockBytes),
    packageLockBytesBase64: packageLockBytes.toString("base64"),
    packages,
    files,
  };
}

export function buildFreshRemediationRuntimeDependencySnapshot({
  repositoryCommit,
  privateParent,
  repoRoot = REPO_ROOT,
}, dependencies = {}) {
  const repository = dependencies.repository || {
    committedBytes: (commit, relativePath) => committedRepositoryBytes(repoRoot, commit, relativePath),
  };
  const packageJsonBytes = repository.committedBytes(repositoryCommit, "package.json");
  const packageLockBytes = repository.committedBytes(repositoryCommit, "package-lock.json");
  if (!Buffer.isBuffer(packageJsonBytes) || !Buffer.isBuffer(packageLockBytes)) {
    fail("Remediation runtime requires committed package manifests");
  }
  const installRoot = fs.mkdtempSync(path.join(privateParent, ".viva-remediation-npm-ci-"));
  fs.chmodSync(installRoot, 0o700);
  try {
    writePrivate(path.join(installRoot, "package.json"), packageJsonBytes);
    writePrivate(path.join(installRoot, "package-lock.json"), packageLockBytes);
    const npmCache = path.join(installRoot, ".npm-cache");
    const npmUserConfig = path.join(installRoot, "user.npmrc");
    const npmGlobalConfig = path.join(installRoot, "global.npmrc");
    fs.mkdirSync(npmCache, { mode: 0o700 });
    writePrivate(npmUserConfig, Buffer.alloc(0));
    writePrivate(npmGlobalConfig, Buffer.alloc(0));
    fs.chmodSync(npmUserConfig, 0o400);
    fs.chmodSync(npmGlobalConfig, 0o400);
    const result = dependencies.runNpmCi
      ? dependencies.runNpmCi({
        installRoot, npmCache, npmUserConfig, npmGlobalConfig, packageJsonBytes, packageLockBytes,
      })
      : spawnSync("/usr/bin/npm", [
        "ci", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund",
      ], {
        cwd: installRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 8 * 1024 * 1024,
        env: {
          PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
          NPM_CONFIG_IGNORE_SCRIPTS: "true",
          NPM_CONFIG_AUDIT: "false",
          NPM_CONFIG_FUND: "false",
          NPM_CONFIG_USERCONFIG: npmUserConfig,
          NPM_CONFIG_GLOBALCONFIG: npmGlobalConfig,
          NPM_CONFIG_CACHE: npmCache,
        },
      });
    if (result?.status !== 0) fail("Fresh private npm ci failed before remediation dependency capture");
    if (!fs.readFileSync(path.join(installRoot, "package.json")).equals(packageJsonBytes)
      || !fs.readFileSync(path.join(installRoot, "package-lock.json")).equals(packageLockBytes)) {
      fail("Fresh private npm ci changed the committed package manifests");
    }
    return collectInstalledRuntimeDependencies(installRoot, packageJsonBytes, packageLockBytes);
  } finally {
    fs.rmSync(installRoot, { recursive: true, force: true });
  }
}

function assertNewExternalDirectory(outputDirectory) {
  if (!path.isAbsolute(String(outputDirectory || ""))) fail("Remediation package output must be absolute");
  const output = path.resolve(outputDirectory);
  const relative = path.relative(REPO_ROOT, output);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    fail("Remediation package output must be outside the repository");
  }
  if (fs.existsSync(output)) fail("Remediation package output must not already exist");
  const parent = path.dirname(output);
  const stat = fs.lstatSync(parent);
  const currentUid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(parent) !== parent
    || stat.uid !== currentUid || (stat.mode & 0o077) !== 0) {
    fail("Remediation package parent must be an owned private canonical directory");
  }
  return output;
}

function writePrivate(filePath, bytes) {
  const descriptor = fs.openSync(filePath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  try {
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function buildManifest(root, repository, planSha256, executionIndexSha256) {
  const files = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const bytes = fs.readFileSync(path.join(root, entry.name));
      return { path: entry.name, size: bytes.length, sha256: sha256(bytes) };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  return {
    formatVersion: 1,
    kind: "viva-game-projection-remediation-package-manifest",
    state: "PREPARED_NOT_AUTHORIZED",
    repository,
    planSha256,
    executionIndexSha256,
    finalCutoverPlanReusable: false,
    files,
  };
}

export function prepareVivaGameProjectionRemediationPackage(options, dependencies = {}) {
  const loaded = {};
  for (const [name, [option, , maximumSize, json]] of Object.entries(INPUTS)) {
    const sourcePath = options[name];
    loaded[name] = json ? jsonArtifact(sourcePath, option, maximumSize) : {
      bytes: readPrivateFile(sourcePath, option, maximumSize),
    };
  }
  const cutoverPlan = loaded.cutoverPlan.value;
  const output = assertNewExternalDirectory(options.outputDirectory);
  const repoRoot = dependencies.repoRoot || REPO_ROOT;
  const repository = dependencies.repository || currentRepository(undefined, repoRoot);
  if (!dependencies.skipCutoverExecutorVerification) assertCommittedExecutorSources(cutoverPlan, repoRoot);
  const executorSources = dependencies.executorSources || executorSourceManifest(repository.commit, repoRoot);
  if (dependencies.runtimeDependencies && dependencies.allowTestRuntimeDependencies !== true
    && dependencies.bootstrapVerified !== true) {
    fail("Injected remediation runtime dependencies are test-only");
  }
  const runtimeDependencies = dependencies.runtimeDependencies
    || buildFreshRemediationRuntimeDependencySnapshot({
      repositoryCommit: repository.commit,
      privateParent: path.dirname(output),
      repoRoot,
    });
  const plan = buildRemediationExecutionPlan({
    artifacts: loaded,
    generatedAt: options.generatedAt,
    mutationAt: options.mutationAt,
    operationId: options.operationId,
    repository,
    executorSources,
    runtimeDependencies,
  });
  const planBytes = Buffer.from(`${JSON.stringify(plan, null, 2)}\n`);
  const planSha256 = sha256(planBytes);
  validateExecutableRemediationPlan(plan, {
    expectedPlanSha256: planSha256,
    planBytes,
    artifacts: loaded,
    expectedExecutorSourcesSha256: plan.executorSourcesSha256,
    nowMs: dependencies.nowMs ?? Date.now(),
  });
  if (!dependencies.skipRemediationExecutorVerification) {
    currentRepository(repository, repoRoot);
    assertCommittedExecutorSources(plan, repoRoot);
  }

  const parent = path.dirname(output);
  const temporary = fs.mkdtempSync(path.join(parent, `.${path.basename(output)}.stage-`));
  let published = false;
  try {
    fs.chmodSync(temporary, 0o700);
    for (const [name, [, fileName]] of Object.entries(INPUTS)) {
      writePrivate(path.join(temporary, fileName), loaded[name].bytes);
    }
    writePrivate(path.join(temporary, "remediation-plan.json"), planBytes);
    const finalPath = (fileName) => path.join(output, fileName);
    const indexInputs = Object.fromEntries(Object.entries(INPUTS).map(([name, [, fileName]]) => [
      name,
      {
        path: name === "flow" ? path.resolve(options.flow) : finalPath(fileName),
        sha256: sha256(loaded[name].bytes),
      },
    ]));
    indexInputs.plan = { path: finalPath("remediation-plan.json"), sha256: planSha256 };
    const executionIndex = {
      formatVersion: 1,
      kind: "viva-game-projection-remediation-execution-index",
      state: "PREPARED_NOT_AUTHORIZED",
      repository,
      inputs: indexInputs,
      executionAuthorized: false,
      liveMutationAuthorized: false,
      productionWritesPerformed: 0,
      finalCutoverPlanReusable: false,
    };
    const executionIndexBytes = Buffer.from(canonicalJson(executionIndex));
    const executionIndexSha256 = sha256(executionIndexBytes);
    validateRemediationExecutionIndex(executionIndex, {
      expectedSha256: executionIndexSha256,
      bytes: executionIndexBytes,
    });
    writePrivate(path.join(temporary, "remediation-execution-index.json"), executionIndexBytes);
    const manifest = buildManifest(temporary, repository, planSha256, executionIndexSha256);
    const expectedFileSha256s = new Map(Object.entries(INPUTS).map(([name, [, fileName]]) => [
      fileName,
      sha256(loaded[name].bytes),
    ]));
    expectedFileSha256s.set("remediation-plan.json", planSha256);
    expectedFileSha256s.set("remediation-execution-index.json", executionIndexSha256);
    if (manifest.files.length !== expectedFileSha256s.size
      || manifest.files.some((entry) => expectedFileSha256s.get(entry.path) !== entry.sha256)) {
      fail("Remediation package durable readback differs from the prepared byte streams");
    }
    const manifestBytes = Buffer.from(canonicalJson(manifest));
    writePrivate(path.join(temporary, "remediation-package.manifest.json"), manifestBytes);
    const marker = {
      formatVersion: 1,
      kind: "viva-game-projection-remediation-prepared-marker",
      state: "PREPARED_NOT_AUTHORIZED",
      planSha256,
      executionIndexSha256,
      manifestSha256: sha256(manifestBytes),
      productionWritesPerformed: 0,
      finalCutoverPlanReusable: false,
    };
    writePrivate(path.join(temporary, "PREPARED_NOT_AUTHORIZED.json"), Buffer.from(canonicalJson(marker)));
    syncDirectory(temporary);
    fs.renameSync(temporary, output);
    published = true;
    syncDirectory(parent);
    const indexReadback = fs.readFileSync(finalPath("remediation-execution-index.json"));
    validateRemediationExecutionIndex(JSON.parse(indexReadback.toString("utf8")), {
      expectedSha256: executionIndexSha256,
      bytes: indexReadback,
    });
    return { output, plan, planSha256, executionIndex, executionIndexSha256, manifest, marker };
  } catch (error) {
    fs.rmSync(published ? output : temporary, { recursive: true, force: true });
    throw error;
  }
}

export function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--") || Object.hasOwn(values, key)) {
      fail(`Invalid argument: ${key || ""}`);
    }
    values[key] = value;
  }
  for (const [option] of Object.values(INPUTS)) if (!values[option]) fail(`Missing ${option}`);
  for (const option of [
    "--generated-at", "--mutation-at", "--operation-id", "--output-directory",
  ]) if (!values[option]) fail(`Missing ${option}`);
  const allowed = new Set([
    ...Object.values(INPUTS).map(([option]) => option),
    "--generated-at", "--mutation-at", "--operation-id", "--output-directory",
  ]);
  const unknown = Object.keys(values).find((key) => !allowed.has(key));
  if (unknown) fail(`Unknown argument: ${unknown}`);
  return {
    ...Object.fromEntries(Object.entries(INPUTS).map(([name, [option]]) => [name, values[option]])),
    generatedAt: values["--generated-at"],
    mutationAt: values["--mutation-at"],
    operationId: values["--operation-id"],
    outputDirectory: values["--output-directory"],
  };
}

export function reportPreparedRemediationPackage(result) {
  process.stdout.write(`${JSON.stringify({
    packageDirectory: result.output,
    state: result.plan.state,
    operationCount: result.plan.operations.length,
    expectedFreshMigrationEligibleCount: result.plan.expectedPostRemediation.activeLegacyEligibleForFreshTenantMigrationPlan,
    planSha256: result.planSha256,
    executionIndexSha256: result.executionIndexSha256,
    finalCutoverPlanReusable: false,
    productionWritesPerformed: 0,
  })}\n`);
}
