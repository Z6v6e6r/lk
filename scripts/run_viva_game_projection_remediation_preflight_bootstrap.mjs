#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const HASH_RE = /^[a-f0-9]{64}$/;
const COMMIT_RE = /^[a-f0-9]{40}$/;
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const LOCK_PATH = "/run/lock/padlhub-viva-game-projection-cutover.lock";
const CLEAN_ENV = Object.freeze({
  PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
  LANG: "C",
  LC_ALL: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_OPTIONAL_LOCKS: "0",
});
const ALLOWED_OPTIONS = new Set([
  "--execution-index", "--expected-execution-index-sha256", "--output-directory", "--report",
]);

export const PREFLIGHT_EXECUTOR_SOURCE_PATHS = Object.freeze([
  "scripts/run_viva_game_projection_remediation_preflight.sh",
  "scripts/run_viva_game_projection_remediation_preflight_bootstrap.mjs",
  "scripts/run_viva_game_projection_remediation_preflight.mjs",
  "scripts/run_viva_game_projection_fence_guardian.mjs",
  "scripts/run_viva_game_projection_recovery_fence_takeover.mjs",
  "scripts/recover_viva_game_projection_mongo_write_barrier.mjs",
  "scripts/finalize_viva_game_projection_cutover_ready.mjs",
  "scripts/prepare_viva_game_projection_cutover_postcheck.mjs",
  "scripts/prepare_viva_game_projection_tenant_migration.mjs",
  "scripts/run_viva_game_projection_tenant_migration.mjs",
  "scripts/lib/vivaGameProjectionCutoverContract.mjs",
  "scripts/lib/vivaGameProjectionCutoverPacketValidation.mjs",
  "scripts/lib/vivaGameProjectionExecutorSource.mjs",
  "scripts/lib/vivaGameProjectionFenceGuardian.mjs",
  "scripts/lib/vivaGameProjectionMongoWriteBarrier.mjs",
  "scripts/lib/vivaGameProjectionRemediationEvidence.mjs",
  "scripts/lib/vivaGameProjectionRemediationExecution.mjs",
  "scripts/lib/vivaGameProjectionTenantMigration.mjs",
  "scripts/lib/vivaGameProjectionTenantMigrationExecution.mjs",
  "scripts/nodered_reviewed_flow_deploy/runtime_contract.mjs",
]);

const REQUIRED_RUNTIME_PACKAGES = Object.freeze([
  "@mongodb-js/saslprep", "bson", "memory-pager", "mongodb", "mongodb-connection-string-url",
  "punycode", "sparse-bitfield", "tr46", "webidl-conversions", "whatwg-url",
]);

const fail = (message) => { throw new Error(message); };
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
};
const canonicalJson = (value) => `${JSON.stringify(stable(value))}\n`;
const gitArgs = (args) => ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args];

const parseArgs = (argv) => {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!ALLOWED_OPTIONS.has(key) || !value || value.startsWith("--") || values.has(key)) {
      fail("Invalid remediation preflight bootstrap arguments");
    }
    values.set(key, value);
  }
  if (values.size !== ALLOWED_OPTIONS.size || [...ALLOWED_OPTIONS].some((key) => !values.has(key))) {
    fail("Remediation preflight bootstrap requires the exact capture-only argument set");
  }
  return Object.fromEntries(values);
};

const readPrivateBytes = (filePath, label, maximumSize = MAX_JSON_BYTES) => {
  if (!path.isAbsolute(String(filePath || "")) || path.resolve(filePath) !== filePath) {
    fail(`${label} path must be absolute and canonical`);
  }
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    const uid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid || (stat.mode & 0o077) !== 0
      || stat.size < 1 || stat.size > maximumSize) {
      fail(`${label} must be an owned private single-link regular file`);
    }
    return fs.readFileSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
};

const readPrivateJson = (filePath, label) => {
  const bytes = readPrivateBytes(filePath, label);
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { fail(`${label} is invalid JSON`); }
  return { bytes, value };
};

const privateDirectory = (directoryPath, label) => {
  if (!path.isAbsolute(String(directoryPath || "")) || path.resolve(directoryPath) !== directoryPath
    || fs.realpathSync(directoryPath) !== directoryPath) fail(`${label} must be canonical`);
  const stat = fs.lstatSync(directoryPath);
  const uid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o077) !== 0) {
    fail(`${label} must be an owned private directory`);
  }
  return directoryPath;
};

const isWithin = (parent, candidate) => {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

const writeExclusive = (filePath, bytes, mode = 0o400) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const descriptor = fs.openSync(filePath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, mode);
  try {
    fs.fchmodSync(descriptor, mode);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
};

const durableReplace = (filePath, value) => {
  const temporary = `${filePath}.tmp-${process.pid}`;
  writeExclusive(temporary, Buffer.from(canonicalJson(value)), 0o600);
  fs.renameSync(temporary, filePath);
  const descriptor = fs.openSync(path.dirname(filePath), fs.constants.O_RDONLY);
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
};

const git = (repoRoot, args, encoding = "utf8") => {
  const result = spawnSync("/usr/bin/git", gitArgs(args), {
    cwd: repoRoot, env: CLEAN_ENV, encoding, maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) fail(`Remediation preflight Git attestation failed: ${args[0]}`);
  return result.stdout;
};

const readCredentialFd = (descriptor, label, maximumSize) => {
  const stat = fs.fstatSync(descriptor);
  const uid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid || (stat.mode & 0o777) !== 0o400
    || stat.size < 32 || stat.size > maximumSize) {
    fail(`${label} descriptor must be an owned 0400 single-link regular file`);
  }
  let bytes;
  try { bytes = fs.readFileSync(descriptor); } finally { fs.closeSync(descriptor); }
  const value = bytes.toString("utf8").trim();
  bytes.fill(0);
  if (!value || value.includes("\n") || value.includes("\r")) fail(`${label} value is invalid`);
  return value;
};

const providerPrincipal = (execution) => {
  const principals = new Set();
  for (const [index, item] of (execution.items || []).entries()) {
    if (!HASH_RE.test(String(item?.planSha256 || ""))) fail(`Migration plan ${index} binding is invalid`);
    const plan = readPrivateJson(item.planPath, `Migration plan ${index}`);
    if (sha256(plan.bytes) !== item.planSha256
      || !HASH_RE.test(String(plan.value?.source?.providerServicePrincipalSha256 || ""))) {
      fail(`Migration plan ${index} provider binding changed`);
    }
    principals.add(plan.value.source.providerServicePrincipalSha256);
  }
  if (principals.size !== 1) fail("Migration plans do not bind one provider service principal");
  return [...principals][0];
};

const validateToken = (token, expectedPrincipalSha256) => {
  const segments = token.split(".");
  if (segments.length < 2) fail("Remediation provider token is not a JWT");
  let claims;
  try { claims = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8")); }
  catch { fail("Remediation provider token claims are invalid"); }
  if (!claims?.sub || sha256(Buffer.from(String(claims.sub))) !== expectedPrincipalSha256) {
    fail("Remediation provider token principal differs from the reviewed plans");
  }
};

const attest = (argv) => {
  if (process.getuid?.() !== 0) fail("Remediation preflight bootstrap requires root");
  const options = parseArgs(argv);
  if (!HASH_RE.test(options["--expected-execution-index-sha256"])) fail("Expected execution-index digest is invalid");
  const executionRead = readPrivateJson(options["--execution-index"], "Cutover execution index");
  if (sha256(executionRead.bytes) !== options["--expected-execution-index-sha256"]
    || executionRead.value?.kind !== "viva-game-projection-cutover-execution-index") {
    fail("Cutover execution index differs before preflight import");
  }
  const execution = executionRead.value;
  if (!path.isAbsolute(String(execution.cutoverPlanPath || ""))
    || !HASH_RE.test(String(execution.cutoverPlanSha256 || ""))) fail("Cutover plan binding is invalid");
  const planRead = readPrivateJson(execution.cutoverPlanPath, "Cutover plan");
  if (sha256(planRead.bytes) !== execution.cutoverPlanSha256
    || planRead.value?.kind !== "viva-game-projection-tenant-cutover-plan") {
    fail("Cutover plan differs before preflight import");
  }
  const plan = planRead.value;
  const repoRoot = fs.realpathSync(process.env.PADLHUB_REMEDIATION_REPOSITORY_ROOT || "");
  const repoStat = fs.lstatSync(repoRoot);
  if (!repoStat.isDirectory() || repoStat.isSymbolicLink() || repoStat.uid !== 0 || (repoStat.mode & 0o022) !== 0
    || !COMMIT_RE.test(String(plan.repository?.commit || ""))
    || String(git(repoRoot, ["rev-parse", "HEAD"])).trim() !== plan.repository.commit
    || String(git(repoRoot, ["status", "--porcelain"])).trim()) {
    fail("Remediation preflight repository is not the exact clean reviewed commit");
  }
  const sourceEntries = new Map();
  if (!Array.isArray(plan.executorSources) || !HASH_RE.test(String(plan.executorSourcesSha256 || ""))
    || sha256(Buffer.from(canonicalJson(plan.executorSources))) !== plan.executorSourcesSha256) {
    fail("Cutover plan executor source manifest is invalid");
  }
  for (const entry of plan.executorSources) {
    if (!String(entry?.path || "").startsWith("scripts/") || !HASH_RE.test(String(entry?.sha256 || ""))) {
      fail("Cutover plan executor source entry is invalid");
    }
    const bytes = git(repoRoot, ["show", `${plan.repository.commit}:${entry.path}`], null);
    if (!Buffer.isBuffer(bytes) || sha256(bytes) !== entry.sha256) fail(`Committed source differs: ${entry.path}`);
    sourceEntries.set(entry.path, bytes);
  }
  if (PREFLIGHT_EXECUTOR_SOURCE_PATHS.some((relativePath) => !sourceEntries.has(relativePath))) {
    fail("Cutover plan omits the recursive remediation preflight source closure");
  }
  const expectedBootstrapSha256 = process.env.PADLHUB_REMEDIATION_PREFLIGHT_BOOTSTRAP_SHA256;
  const expectedWrapperSha256 = process.env.PADLHUB_REMEDIATION_PREFLIGHT_WRAPPER_SHA256;
  if (!HASH_RE.test(String(expectedBootstrapSha256 || "")) || !HASH_RE.test(String(expectedWrapperSha256 || ""))
    || sha256(fs.readFileSync(SCRIPT_PATH)) !== expectedBootstrapSha256
    || sourceEntries.get("scripts/run_viva_game_projection_remediation_preflight_bootstrap.mjs")
      && sha256(sourceEntries.get("scripts/run_viva_game_projection_remediation_preflight_bootstrap.mjs")) !== expectedBootstrapSha256
    || sha256(sourceEntries.get("scripts/run_viva_game_projection_remediation_preflight.sh")) !== expectedWrapperSha256) {
    fail("External remediation preflight wrapper/bootstrap trust anchor differs from the reviewed plan");
  }
  const packageJson = git(repoRoot, ["show", `${plan.repository.commit}:package.json`], null);
  const packageLock = git(repoRoot, ["show", `${plan.repository.commit}:package-lock.json`], null);
  let lock;
  try { lock = JSON.parse(packageLock.toString("utf8")); JSON.parse(packageJson.toString("utf8")); }
  catch { fail("Committed runtime package manifests are invalid"); }
  for (const name of REQUIRED_RUNTIME_PACKAGES) {
    const entry = lock?.packages?.[`node_modules/${name}`];
    if (!entry?.version || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(String(entry.integrity || ""))) {
      fail(`Committed runtime dependency is not SRI-bound: ${name}`);
    }
  }
  const expectedPrincipalSha256 = providerPrincipal(execution);
  if (process.env.PADLHUB_REMEDIATION_PROVIDER_TOKEN_FD !== "10"
    || process.env.PADLHUB_REMEDIATION_FENCE_TOKEN_FD !== "7") {
    fail("Private provider and fence credential descriptors are required");
  }
  const providerToken = readCredentialFd(10, "Provider token", 32 * 1024);
  validateToken(providerToken, expectedPrincipalSha256);
  const fenceToken = readCredentialFd(7, "Fence token", 1024);
  if (sha256(Buffer.from(fenceToken)) !== plan.writerFence?.fenceTokenSha256) {
    fail("Private fence token differs from the cutover plan");
  }
  delete process.env.PADLHUB_REMEDIATION_PROVIDER_TOKEN_FD;
  delete process.env.PADLHUB_REMEDIATION_FENCE_TOKEN_FD;
  return { options, execution, plan, repoRoot, sourceEntries, packageJson, packageLock, providerToken, fenceToken };
};

const assertOutputCustody = (attestation) => {
  const { options, execution, repoRoot } = attestation;
  const packetRoot = fs.realpathSync(path.dirname(execution.cutoverPlanPath));
  const runtimeRoot = privateDirectory(
    process.env.PADLHUB_REMEDIATION_RUNTIME_DIR || "", "Remediation runtime root",
  );
  const outputDirectory = options["--output-directory"];
  const report = options["--report"];
  const guardian = {
    receipt: process.env.PADLHUB_CUTOVER_GUARDIAN_RECEIPT,
    release: process.env.PADLHUB_CUTOVER_GUARDIAN_RELEASE_REQUEST,
    recovery: process.env.PADLHUB_CUTOVER_GUARDIAN_RECOVERY_REQUEST,
    ready: process.env.PADLHUB_CUTOVER_GUARDIAN_READY_REQUEST,
    heartbeat: process.env.PADLHUB_CUTOVER_GUARDIAN_HEARTBEAT,
  };
  const paths = [outputDirectory, report, execution.mongoWriteBarrierReceiptOutputPath, ...Object.values(guardian)];
  if (paths.some((value) => !path.isAbsolute(String(value || "")) || path.resolve(value) !== value)) {
    fail("Remediation preflight custody paths must be absolute and canonical");
  }
  const writes = [
    outputDirectory, report, `${report}.journal`, `${report}.bootstrap-custody.json`,
    execution.mongoWriteBarrierReceiptOutputPath, `${execution.mongoWriteBarrierReceiptOutputPath}.prepared`,
    guardian.receipt, `${guardian.receipt}.log`, guardian.release, guardian.recovery, guardian.ready, guardian.heartbeat,
  ].map((value) => path.resolve(value));
  const protectedPaths = [
    packetRoot, repoRoot, options["--execution-index"], execution.cutoverPlanPath, execution.packetManifestPath,
    execution.fenceReceiptPath, execution.liveFlowPath, execution.migrationConnectionFile,
    path.join(runtimeRoot, "bootstrap.mjs"),
    path.join(runtimeRoot, "launcher.sh"),
    path.join(runtimeRoot, "executor"),
    path.join(runtimeRoot, "npm-cache"),
    path.join(runtimeRoot, "user.npmrc"),
    path.join(runtimeRoot, "global.npmrc"),
  ].map((value) => path.resolve(value));
  if (writes.some((target) => fs.existsSync(target)
    || protectedPaths.some((protectedPath) => isWithin(protectedPath, target) || isWithin(target, protectedPath)))) {
    fail("Remediation preflight output overlaps existing or pinned state");
  }
  for (let left = 0; left < writes.length; left += 1) {
    privateDirectory(path.dirname(writes[left]), "Remediation preflight output parent");
    for (let right = left + 1; right < writes.length; right += 1) {
      if (isWithin(writes[left], writes[right]) || isWithin(writes[right], writes[left])) {
        fail("Remediation preflight custody paths are not pairwise disjoint");
      }
    }
  }
  return { outputDirectory, report, guardian, bootstrapReceipt: `${report}.bootstrap-custody.json` };
};

const freezeTree = (target) => {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) fail("Remediation preflight runtime contains a symlink");
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(target)) freezeTree(path.join(target, entry));
    fs.chmodSync(target, 0o500);
  } else if (stat.isFile()) fs.chmodSync(target, 0o400);
  else fail("Remediation preflight runtime contains an unsupported file type");
};

const removeGeneratedBinDirectories = (target) => {
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const candidate = path.join(target, entry.name);
    if (entry.isDirectory() && entry.name === ".bin") fs.rmSync(candidate, { recursive: true, force: true });
    else if (entry.isDirectory()) removeGeneratedBinDirectories(candidate);
  }
};

const materializeRuntime = (attestation) => {
  const runtimeRoot = privateDirectory(process.env.PADLHUB_REMEDIATION_RUNTIME_DIR || "", "Remediation runtime root");
  const snapshot = path.join(runtimeRoot, "executor");
  fs.mkdirSync(snapshot, { mode: 0o700 });
  for (const [relativePath, bytes] of attestation.sourceEntries) {
    writeExclusive(path.join(snapshot, relativePath), bytes);
  }
  writeExclusive(path.join(snapshot, "package.json"), attestation.packageJson);
  writeExclusive(path.join(snapshot, "package-lock.json"), attestation.packageLock);
  const cache = path.join(runtimeRoot, "npm-cache");
  const userConfig = path.join(runtimeRoot, "user.npmrc");
  const globalConfig = path.join(runtimeRoot, "global.npmrc");
  fs.mkdirSync(cache, { mode: 0o700 });
  writeExclusive(userConfig, Buffer.alloc(0));
  writeExclusive(globalConfig, Buffer.alloc(0));
  const install = spawnSync("/usr/bin/npm", [
    "ci", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund",
  ], {
    cwd: snapshot,
    stdio: ["ignore", "ignore", "pipe"],
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    env: {
      ...CLEAN_ENV,
      NPM_CONFIG_IGNORE_SCRIPTS: "true",
      NPM_CONFIG_AUDIT: "false",
      NPM_CONFIG_FUND: "false",
      NPM_CONFIG_USERCONFIG: userConfig,
      NPM_CONFIG_GLOBALCONFIG: globalConfig,
      NPM_CONFIG_CACHE: cache,
    },
  });
  if (install.status !== 0
    || !fs.readFileSync(path.join(snapshot, "package.json")).equals(attestation.packageJson)
    || !fs.readFileSync(path.join(snapshot, "package-lock.json")).equals(attestation.packageLock)
    || REQUIRED_RUNTIME_PACKAGES.some((name) => !fs.existsSync(path.join(snapshot, "node_modules", name, "package.json")))) {
    fail("Fresh SRI-bound remediation preflight runtime installation failed");
  }
  removeGeneratedBinDirectories(path.join(snapshot, "node_modules"));
  freezeTree(snapshot);
  return snapshot;
};

const acquireFence = () => {
  const parent = fs.lstatSync(path.dirname(LOCK_PATH));
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== 0 || fs.realpathSync(path.dirname(LOCK_PATH)) !== path.dirname(LOCK_PATH)) {
    fail("Canonical root-owned lock directory is unavailable");
  }
  const descriptor = fs.openSync(LOCK_PATH, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
  const stat = fs.fstatSync(descriptor);
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== 0) {
    fs.closeSync(descriptor);
    fail("Canonical writer-fence lock file is unsafe");
  }
  fs.fchmodSync(descriptor, 0o600);
  const stdio = Array.from({ length: 10 }, () => "ignore");
  stdio[9] = descriptor;
  const locked = spawnSync("/usr/bin/flock", ["-n", "9"], { env: CLEAN_ENV, stdio });
  if (locked.status !== 0) {
    fs.closeSync(descriptor);
    fail("Another PadlHub Viva projection operation holds the writer fence");
  }
  return descriptor;
};

export const assertAttestedFenceLease = ({
  receipt, lockDescriptor, fenceToken, lockPath = LOCK_PATH, probe = null,
}) => {
  const descriptorStat = fs.fstatSync(lockDescriptor);
  const lockStat = fs.statSync(lockPath);
  if (receipt?.lockPath !== lockPath || receipt?.fenceToken !== fenceToken
    || sha256(Buffer.from(fenceToken)) !== receipt?.fenceTokenSha256
    || !descriptorStat.isFile() || descriptorStat.dev !== lockStat.dev || descriptorStat.ino !== lockStat.ino) {
    fail("Attested remediation preflight fence lease differs from the writer-fence receipt");
  }
  const probeResult = probe ? probe() : spawnSync(
    "/usr/bin/flock", ["-n", lockPath, "-c", "true"], { env: CLEAN_ENV, stdio: "ignore" },
  );
  if (probe ? probeResult !== true : (probeResult.error || probeResult.status === 0)) {
    fail("Attested remediation preflight writer-fence flock is not held exclusively");
  }
  return true;
};

const startGuardian = (attestation, custody, snapshot, lockDescriptor) => {
  const logDescriptor = fs.openSync(`${custody.guardian.receipt}.log`, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  const stdio = Array.from({ length: 10 }, (_, index) => (index === 0 ? "ignore" : (index < 3 ? logDescriptor : "ignore")));
  stdio[9] = lockDescriptor;
  const child = spawn("/usr/bin/node", [
    path.join(snapshot, "scripts/run_viva_game_projection_fence_guardian.mjs"),
    "--receipt", custody.guardian.receipt,
    "--release-request", custody.guardian.release,
    "--recovery-request", custody.guardian.recovery,
    "--ready-request", custody.guardian.ready,
    "--heartbeat", custody.guardian.heartbeat,
  ], {
    detached: true,
    stdio,
    env: {
      ...CLEAN_ENV,
      PADLHUB_CUTOVER_FENCE_FD: "9",
      PADLHUB_CUTOVER_FENCE_LOCK_PATH: LOCK_PATH,
      PADLHUB_CUTOVER_FENCE_TOKEN: attestation.fenceToken,
      PADLHUB_ATTESTED_EXECUTOR_SNAPSHOT_ROOT: snapshot,
      PADLHUB_ATTESTED_EXECUTOR_COMMIT: attestation.plan.repository.commit,
      VIVA_GAME_PROJECTION_MONGO_BARRIER_RECOVER: "RECOVER_VIVA_GAME_PROJECTION_MONGO_WRITE_BARRIER_V1",
    },
  });
  fs.closeSync(logDescriptor);
  child.unref();
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && (!fs.existsSync(custody.guardian.receipt) || !fs.existsSync(custody.guardian.heartbeat))) {
    try { process.kill(child.pid, 0); } catch { fail("Persistent fence guardian failed to start"); }
    const wait = spawnSync("/usr/bin/sleep", ["0.1"], { env: CLEAN_ENV, stdio: "ignore" });
    if (wait.status !== 0) fail("Unable to wait for persistent fence guardian");
  }
  if (!fs.existsSync(custody.guardian.receipt) || !fs.existsSync(custody.guardian.heartbeat)) {
    fail("Persistent fence guardian did not publish its custody artifacts");
  }
  return child.pid;
};

export async function main(argv = process.argv.slice(2)) {
  const expectedBootstrapSha256 = process.env.PADLHUB_REMEDIATION_PREFLIGHT_BOOTSTRAP_SHA256;
  if (!HASH_RE.test(String(expectedBootstrapSha256 || ""))
    || sha256(fs.readFileSync(SCRIPT_PATH)) !== expectedBootstrapSha256) {
    fail("Remediation preflight bootstrap lacks its external byte-stream trust anchor");
  }
  const attestation = attest(argv);
  const custody = assertOutputCustody(attestation);
  const snapshot = materializeRuntime(attestation);
  writeExclusive(custody.bootstrapReceipt, Buffer.from(canonicalJson({
    formatVersion: 1,
    kind: "viva-game-projection-remediation-preflight-bootstrap-custody",
    state: "PREVALIDATED_BEFORE_FENCE_ACQUISITION",
    cutoverPlanSha256: attestation.execution.cutoverPlanSha256,
    cutoverExecutionIndexSha256: attestation.options["--expected-execution-index-sha256"],
    reportPath: custody.report,
    outputDirectory: custody.outputDirectory,
    recoveryRequestPath: custody.guardian.recovery,
  })), 0o600);
  const lockDescriptor = acquireFence();
  const guardianPid = startGuardian(attestation, custody, snapshot, lockDescriptor);
  durableReplace(custody.bootstrapReceipt, {
    formatVersion: 1,
    kind: "viva-game-projection-remediation-preflight-bootstrap-custody",
    state: "GUARDIAN_STARTED_FENCE_HELD_RUNTIME_UNVERIFIED",
    cutoverPlanSha256: attestation.execution.cutoverPlanSha256,
    cutoverExecutionIndexSha256: attestation.options["--expected-execution-index-sha256"],
    reportPath: custody.report,
    outputDirectory: custody.outputDirectory,
    guardianReceiptPath: custody.guardian.receipt,
    guardianPid,
    recoveryRequestPath: custody.guardian.recovery,
    mongoWriteBarrierReceiptPath: attestation.execution.mongoWriteBarrierReceiptOutputPath,
  });
  process.env.PADLHUB_CUTOVER_FENCE_LOCK_PATH = LOCK_PATH;
  process.env.PADLHUB_CUTOVER_GUARDIAN_RECEIPT = custody.guardian.receipt;
  process.env.PADLHUB_CUTOVER_GUARDIAN_RELEASE_REQUEST = custody.guardian.release;
  process.env.PADLHUB_CUTOVER_GUARDIAN_RECOVERY_REQUEST = custody.guardian.recovery;
  process.env.PADLHUB_CUTOVER_GUARDIAN_READY_REQUEST = custody.guardian.ready;
  process.env.PADLHUB_CUTOVER_GUARDIAN_HEARTBEAT = custody.guardian.heartbeat;
  process.env.PADLHUB_CUTOVER_GUARDIAN_PID = String(guardianPid);
  process.env.VIVA_GAME_PROJECTION_REMEDIATION_PREFLIGHT = "CAPTURE_VIVA_GAME_PROJECTION_REMEDIATION_PREFLIGHT_V1";
  process.env.VIVA_GAME_PROJECTION_MONGO_BARRIER_RECOVER = "RECOVER_VIVA_GAME_PROJECTION_MONGO_WRITE_BARRIER_V1";
  const runner = await import(pathToFileURL(path.join(
    snapshot, "scripts/run_viva_game_projection_remediation_preflight.mjs",
  )).href);
  return runner.executeVivaGameProjectionRemediationPreflight(runner.parseArgs(argv), {
    bootstrapAttested: true,
    providerToken: attestation.providerToken,
    providerTokenValidated: true,
    assertFenceLease(receipt) {
      return assertAttestedFenceLease({
        receipt,
        lockDescriptor,
        fenceToken: attestation.fenceToken,
      });
    },
    assertExecutorSources(candidate) {
      if (candidate?.repository?.commit !== attestation.plan.repository.commit
        || canonicalJson(candidate?.executorSources) !== canonicalJson(attestation.plan.executorSources)) {
        fail("Snapshot runner differs from the pre-import source attestation");
      }
      return true;
    },
  });
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === SCRIPT_PATH) {
  main().then((report) => process.stdout.write(`${JSON.stringify({
    state: report.state,
    evidenceManifestSha256: report.evidenceManifestSha256,
    mongoWriteBarrierState: report.mongoWriteBarrierState,
    nodeRedState: report.nodeRedState,
    gameDocumentWritesPerformed: 0,
    providerWritesPerformed: 0,
    operatorActionRequired: true,
  })}\n`)).catch(() => {
    process.stderr.write("Remediation preflight bootstrap failed; inspect private custody and report artifacts\n");
    process.exitCode = 1;
  });
}
