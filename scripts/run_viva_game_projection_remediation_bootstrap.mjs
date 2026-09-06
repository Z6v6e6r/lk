#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = fs.realpathSync(process.env.PADLHUB_REMEDIATION_REPOSITORY_ROOT
  || path.resolve(path.dirname(SCRIPT_PATH), ".."));
const HASH_RE = /^[a-f0-9]{64}$/;
const COMMIT_RE = /^[a-f0-9]{40}$/;
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const MAX_RUNTIME_FILES = 2_000;
const MAX_RUNTIME_BYTES = 32 * 1024 * 1024;
const INDEX_ALLOWED_OPTIONS = new Set([
  "--execution-index", "--expected-execution-index-sha256", "--mode", "--report", "--backup-dir",
  "--backup", "--expected-backup-sha256", "--apply-receipt", "--expected-apply-report-sha256",
]);

export const BOOTSTRAP_REMEDIATION_EXECUTOR_SOURCE_PATHS = Object.freeze([
  "scripts/run_viva_game_projection_fenced_remediation.sh",
  "scripts/run_viva_game_projection_remediation_bootstrap.mjs",
  "scripts/run_viva_game_projection_remediation.mjs",
  "scripts/run_viva_game_projection_tenant_migration.mjs",
  "scripts/prepare_viva_game_projection_tenant_migration.mjs",
  "scripts/lib/vivaGameProjectionRemediationExecution.mjs",
  "scripts/lib/vivaGameProjectionRemediationPackage.mjs",
  "scripts/lib/vivaGameProjectionMongoWriteBarrier.mjs",
  "scripts/lib/vivaGameProjectionExecutorSource.mjs",
  "scripts/lib/vivaGameProjectionCutoverContract.mjs",
  "scripts/lib/vivaGameProjectionTenantMigrationExecution.mjs",
  "scripts/lib/vivaGameProjectionTenantMigration.mjs",
  "scripts/lib/vivaGameProjectionCutoverPacketValidation.mjs",
  "scripts/nodered_reviewed_flow_deploy/runtime_contract.mjs",
]);
export const BOOTSTRAP_REMEDIATION_RUNTIME_PACKAGE_NAMES = Object.freeze([
  "@mongodb-js/saslprep",
  "bson",
  "memory-pager",
  "mongodb",
  "mongodb-connection-string-url",
  "punycode",
  "sparse-bitfield",
  "tr46",
  "webidl-conversions",
  "whatwg-url",
]);

const fail = (message) => { throw new Error(message); };
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
};
const canonicalJson = (value) => `${JSON.stringify(stable(value))}\n`;
const GIT_ENV = Object.freeze({
  PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
  LANG: "C",
  LC_ALL: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_OPTIONAL_LOCKS: "0",
});
const gitArgs = (args) => ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args];

const parseValues = (argv) => {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--") || values.has(key)) {
      fail(`Invalid argument: ${key || ""}`);
    }
    values.set(key, value);
  }
  return values;
};

const readPrivateJson = (filePath, label) => {
  if (!path.isAbsolute(String(filePath || ""))) fail(`${label} path must be absolute`);
  const requested = path.resolve(filePath);
  if (fs.realpathSync(requested) !== requested) fail(`${label} path must be canonical`);
  const descriptor = fs.openSync(requested, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    const uid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid || (stat.mode & 0o077) !== 0
      || stat.size < 1 || stat.size > MAX_JSON_BYTES) {
      fail(`${label} must be an owned private single-link regular file`);
    }
    const bytes = fs.readFileSync(descriptor);
    let value;
    try { value = JSON.parse(bytes.toString("utf8")); } catch { fail(`${label} must contain valid JSON`); }
    return { bytes, value };
  } finally {
    fs.closeSync(descriptor);
  }
};

const defaultRepository = (repoRoot) => ({
  head() {
    const result = spawnSync("/usr/bin/git", gitArgs(["rev-parse", "HEAD"]), {
      cwd: repoRoot, encoding: "utf8", env: GIT_ENV,
    });
    if (result.status !== 0) fail("Unable to read remediation executor repository HEAD");
    return result.stdout.trim();
  },
  status() {
    const result = spawnSync("/usr/bin/git", gitArgs(["status", "--porcelain"]), {
      cwd: repoRoot, encoding: "utf8", env: GIT_ENV,
    });
    if (result.status !== 0) fail("Unable to read remediation executor repository status");
    return result.stdout;
  },
  committedBytes(commit, relativePath) {
    const result = spawnSync("/usr/bin/git", gitArgs(["show", `${commit}:${relativePath}`]), {
      cwd: repoRoot,
      encoding: null,
      maxBuffer: 32 * 1024 * 1024,
      env: GIT_ENV,
    });
    if (result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
      fail(`Unable to read committed remediation executor source: ${relativePath}`);
    }
    return result.stdout;
  },
});

const planBinding = (argv) => {
  const values = parseValues(argv);
  if ([...values.keys()].some((key) => !INDEX_ALLOWED_OPTIONS.has(key))) {
    fail("Production remediation bootstrap accepts only execution-index mode and recovery outputs");
  }
  if (!values.get("--execution-index") || !values.get("--mode") || !values.get("--report")) {
    fail("Production remediation bootstrap requires execution index, mode, and report");
  }
  const expectedIndexSha256 = values.get("--expected-execution-index-sha256");
  if (!HASH_RE.test(String(expectedIndexSha256 || ""))) fail("Expected remediation execution-index digest is missing");
  const index = readPrivateJson(values.get("--execution-index"), "Remediation execution index");
  if (sha256(index.bytes) !== expectedIndexSha256
    || index.value?.kind !== "viva-game-projection-remediation-execution-index") {
    fail("Remediation execution index digest or contract mismatch");
  }
  return {
    path: index.value?.inputs?.plan?.path,
    sha256: index.value?.inputs?.plan?.sha256,
  };
};

export function verifyRemediationExecutorBootstrap(argv, dependencies = {}) {
  const repoRoot = fs.realpathSync(dependencies.repoRoot || REPO_ROOT);
  const repository = dependencies.repository || defaultRepository(repoRoot);
  const binding = planBinding(argv);
  if (!HASH_RE.test(String(binding.sha256 || ""))) fail("Expected remediation plan digest is missing");
  const planRead = readPrivateJson(binding.path, "Remediation plan");
  if (sha256(planRead.bytes) !== binding.sha256) fail("Remediation plan digest mismatch before executor import");
  const plan = planRead.value;
  const commit = plan?.repository?.commit;
  if (!COMMIT_RE.test(String(commit || "")) || repository.head() !== commit || repository.status().trim()) {
    fail("Remediation executor requires the exact clean committed repository before import");
  }
  const sources = plan?.executorSources;
  if (!Array.isArray(sources)
    || sources.map((entry) => entry?.path).sort().join("\0")
      !== [...BOOTSTRAP_REMEDIATION_EXECUTOR_SOURCE_PATHS].sort().join("\0")
    || sha256(canonicalJson(sources)) !== plan.executorSourcesSha256) {
    fail("Remediation executor source closure is incomplete before import");
  }
  const committedSources = new Map();
  for (const entry of sources) {
    if (!entry || Object.keys(entry).sort().join(",") !== "path,sha256"
      || !HASH_RE.test(String(entry.sha256 || ""))) {
      fail("Remediation executor source entry is invalid before import");
    }
    const relative = path.relative(repoRoot, path.resolve(repoRoot, entry.path));
    if (relative !== entry.path || relative.startsWith("..") || path.isAbsolute(relative)) {
      fail(`Remediation executor source path is unsafe before import: ${entry.path}`);
    }
    const committed = repository.committedBytes(commit, entry.path);
    if (!Buffer.isBuffer(committed) || sha256(committed) !== entry.sha256) {
      fail(`Remediation executor source differs before import: ${entry.path}`);
    }
    committedSources.set(entry.path, Buffer.from(committed));
  }
  const runtime = plan?.runtimeDependencies;
  if (!runtime || sha256(canonicalJson(runtime)) !== plan.runtimeDependenciesSha256
    || runtime.formatVersion !== 1 || runtime.kind !== "viva-game-projection-runtime-dependency-snapshot"
    || runtime.installMethod !== "fresh-private-npm-ci-ignore-scripts-omit-dev"
    || !HASH_RE.test(String(runtime.packageJsonSha256 || ""))
    || !HASH_RE.test(String(runtime.packageLockSha256 || ""))
    || !Array.isArray(runtime.packages) || !Array.isArray(runtime.files)
    || runtime.files.length < BOOTSTRAP_REMEDIATION_RUNTIME_PACKAGE_NAMES.length
    || runtime.files.length > MAX_RUNTIME_FILES) {
    fail("Remediation runtime dependency snapshot is invalid before import");
  }
  const packageJsonBytes = Buffer.from(String(runtime.packageJsonBytesBase64 || ""), "base64");
  const packageLockBytes = Buffer.from(String(runtime.packageLockBytesBase64 || ""), "base64");
  if (!runtime.packageJsonBytesBase64 || packageJsonBytes.toString("base64") !== runtime.packageJsonBytesBase64
    || sha256(packageJsonBytes) !== runtime.packageJsonSha256
    || !repository.committedBytes(commit, "package.json").equals(packageJsonBytes)
    || !runtime.packageLockBytesBase64 || packageLockBytes.toString("base64") !== runtime.packageLockBytesBase64
    || sha256(packageLockBytes) !== runtime.packageLockSha256
    || !repository.committedBytes(commit, "package-lock.json").equals(packageLockBytes)) {
    fail("Remediation runtime package lock differs from the committed byte stream");
  }
  let packageLock;
  try {
    JSON.parse(packageJsonBytes.toString("utf8"));
    packageLock = JSON.parse(packageLockBytes.toString("utf8"));
  }
  catch { fail("Remediation runtime package lock is invalid before import"); }
  const packageNames = runtime.packages.map((entry) => entry?.name);
  if (packageNames.slice().sort().join("\0") !== [...BOOTSTRAP_REMEDIATION_RUNTIME_PACKAGE_NAMES].sort().join("\0")
    || new Set(packageNames).size !== packageNames.length) {
    fail("Remediation runtime package set is incomplete before import");
  }
  for (const entry of runtime.packages) {
    const locked = packageLock?.packages?.[`node_modules/${entry.name}`];
    if (!entry || Object.keys(entry).sort().join(",") !== "integrity,name,version"
      || locked?.version !== entry.version || locked?.integrity !== entry.integrity
      || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(String(entry.integrity || ""))) {
      fail("Remediation runtime package differs from the exact package lock before import");
    }
  }
  const runtimeDependencyBytes = new Map();
  let totalRuntimeBytes = 0;
  const runtimePaths = [];
  for (const entry of runtime.files) {
    const relativePath = String(entry?.path || "");
    const parts = relativePath.split("/");
    if (!entry || Object.keys(entry).sort().join(",") !== "bytesBase64,path,sha256,size"
      || !BOOTSTRAP_REMEDIATION_RUNTIME_PACKAGE_NAMES.some((name) => relativePath.startsWith(`node_modules/${name}/`))
      || relativePath.includes("\\") || parts.some((part) => !part || part === "." || part === "..")
      || !Number.isSafeInteger(entry.size) || entry.size < 0 || !HASH_RE.test(String(entry.sha256 || ""))) {
      fail("Remediation runtime dependency file metadata is invalid before import");
    }
    const bytes = Buffer.from(String(entry.bytesBase64 || ""), "base64");
    if (bytes.toString("base64") !== entry.bytesBase64 || bytes.length !== entry.size || sha256(bytes) !== entry.sha256) {
      fail(`Remediation runtime dependency differs before import: ${relativePath}`);
    }
    runtimePaths.push(relativePath);
    totalRuntimeBytes += bytes.length;
    runtimeDependencyBytes.set(relativePath, bytes);
  }
  if (totalRuntimeBytes > MAX_RUNTIME_BYTES || new Set(runtimePaths).size !== runtimePaths.length
    || JSON.stringify(runtimePaths) !== JSON.stringify([...runtimePaths].sort())
    || BOOTSTRAP_REMEDIATION_RUNTIME_PACKAGE_NAMES.some((name) => (
      !runtimeDependencyBytes.has(`node_modules/${name}/package.json`)
    ))) {
    fail("Remediation runtime dependency file closure is incomplete before import");
  }
  return {
    plan,
    planSha256: binding.sha256,
    repositoryCommit: commit,
    committedSources,
    runtimeDependencyBytes,
  };
}

export function materializeRemediationExecutorSnapshot(attestation, dependencies = {}) {
  const configuredRuntimeRoot = dependencies.runtimeRoot || process.env.PADLHUB_REMEDIATION_RUNTIME_DIR;
  if (!path.isAbsolute(String(configuredRuntimeRoot || ""))) fail("Remediation private runtime directory is required");
  const runtimeRoot = path.resolve(configuredRuntimeRoot);
  const runtimeRootStat = fs.lstatSync(runtimeRoot);
  const uid = typeof process.getuid === "function" ? process.getuid() : runtimeRootStat.uid;
  if (fs.realpathSync(runtimeRoot) !== runtimeRoot || !runtimeRootStat.isDirectory()
    || runtimeRootStat.isSymbolicLink() || runtimeRootStat.uid !== uid || (runtimeRootStat.mode & 0o077) !== 0) {
    fail("Remediation private runtime directory is unsafe");
  }
  const snapshotRoot = path.join(runtimeRoot, "executor");
  fs.mkdirSync(snapshotRoot, { mode: 0o700 });
  const directories = new Set([snapshotRoot]);
  const writeSnapshotFile = (relativePath, bytes, expectedSha256) => {
    const target = path.join(snapshotRoot, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    let current = path.dirname(target);
    while (current.startsWith(snapshotRoot)) {
      directories.add(current);
      if (current === snapshotRoot) break;
      current = path.dirname(current);
    }
    const descriptor = fs.openSync(target, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o400);
    try {
      fs.writeFileSync(descriptor, bytes);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    if (sha256(fs.readFileSync(target)) !== expectedSha256) {
      fail(`Remediation snapshot readback differs: ${relativePath}`);
    }
  };
  for (const relativePath of BOOTSTRAP_REMEDIATION_EXECUTOR_SOURCE_PATHS) {
    const bytes = attestation.committedSources.get(relativePath);
    if (!Buffer.isBuffer(bytes)) fail(`Attested remediation source is missing: ${relativePath}`);
    writeSnapshotFile(
      relativePath,
      bytes,
      attestation.plan.executorSources.find((entry) => entry.path === relativePath).sha256,
    );
  }
  for (const entry of attestation.plan.runtimeDependencies.files) {
    const bytes = attestation.runtimeDependencyBytes.get(entry.path);
    if (!Buffer.isBuffer(bytes)) fail(`Attested remediation runtime dependency is missing: ${entry.path}`);
    writeSnapshotFile(entry.path, bytes, entry.sha256);
  }
  for (const directory of [...directories].sort((left, right) => right.length - left.length)) fs.chmodSync(directory, 0o500);
  return snapshotRoot;
}

const assertExternalTrustAnchor = () => {
  const expectedBootstrapSha256 = String(process.env.PADLHUB_REMEDIATION_BOOTSTRAP_SHA256 || "");
  const expectedWrapperSha256 = String(process.env.PADLHUB_REMEDIATION_WRAPPER_SHA256 || "");
  if (!HASH_RE.test(expectedBootstrapSha256) || !HASH_RE.test(expectedWrapperSha256)
    || sha256(fs.readFileSync(SCRIPT_PATH)) !== expectedBootstrapSha256) {
    fail("Externally pinned remediation wrapper/bootstrap trust anchor is absent or mismatched");
  }
};

const assertPlanTrustAnchors = (attestation) => {
  const expectedBootstrapSha256 = String(process.env.PADLHUB_REMEDIATION_BOOTSTRAP_SHA256 || "");
  const expectedWrapperSha256 = String(process.env.PADLHUB_REMEDIATION_WRAPPER_SHA256 || "");
  const sources = new Map(attestation.plan.executorSources.map((entry) => [entry.path, entry.sha256]));
  if (sources.get("scripts/run_viva_game_projection_remediation_bootstrap.mjs") !== expectedBootstrapSha256
    || sources.get("scripts/run_viva_game_projection_fenced_remediation.sh") !== expectedWrapperSha256) {
    fail("External remediation trust anchor differs from the reviewed plan");
  }
};

const installFenceTokenAfterAttestation = () => {
  if (process.env.PADLHUB_REMEDIATION_FENCE_TOKEN_FD !== "7") {
    fail("Private remediation fence-token descriptor is absent after attestation");
  }
  const stat = fs.fstatSync(7);
  const uid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid || (stat.mode & 0o077) !== 0 || stat.size > 1024) {
    fail("Private remediation fence-token descriptor is unsafe after attestation");
  }
  const token = fs.readFileSync(7, "utf8");
  fs.closeSync(7);
  if (!token || token.includes("\n") || token.includes("\r")) fail("Private remediation fence token is invalid");
  process.env.PADLHUB_CUTOVER_FENCE_TOKEN = token;
  delete process.env.PADLHUB_REMEDIATION_FENCE_TOKEN_FD;
};

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  if (!dependencies.trustAnchorVerified) assertExternalTrustAnchor();
  const attestation = verifyRemediationExecutorBootstrap(argv, dependencies);
  if (!dependencies.trustAnchorVerified) assertPlanTrustAnchors(attestation);
  if (!dependencies.trustAnchorVerified) installFenceTokenAfterAttestation();
  const snapshotRoot = dependencies.loadRunner
    ? null
    : materializeRemediationExecutorSnapshot(attestation, dependencies);
  const loadRunner = dependencies.loadRunner || (() => import(pathToFileURL(
    path.join(snapshotRoot, "scripts/run_viva_game_projection_remediation.mjs"),
  ).href));
  const runner = await loadRunner();
  if (typeof runner?.main !== "function") fail("Remediation runner entrypoint is missing after verified import");
  const runnerDependencies = {
    ...(dependencies.runnerDependencies || {}),
    assertExecutorSources(candidate) {
      if (canonicalJson(candidate?.executorSources) !== canonicalJson(attestation.plan.executorSources)
        || candidate?.repository?.commit !== attestation.repositoryCommit) {
        fail("Snapshot runner plan differs from the pre-import executor attestation");
      }
      return true;
    },
  };
  return runner.main(argv, runnerDependencies);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    const message = String(error instanceof Error ? error.message : error)
      .replace(/mongodb(?:\+srv)?:\/\/[^\s]+/gi, "[REDACTED_MONGO_URI]")
      .slice(0, 500);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
