#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = fs.realpathSync(path.resolve(path.dirname(SCRIPT_PATH), ".."));
const COMMIT_RE = /^[a-f0-9]{40}$/;
export const REMEDIATION_BUILDER_SOURCE_PATHS = Object.freeze([
  "scripts/lib/prepareVivaGameProjectionRemediationPackage.mjs",
  "scripts/lib/vivaGameProjectionCutoverContract.mjs",
  "scripts/lib/vivaGameProjectionExecutorSource.mjs",
  "scripts/lib/vivaGameProjectionRemediationExecution.mjs",
  "scripts/lib/vivaGameProjectionRemediationPackage.mjs",
  "scripts/lib/vivaGameProjectionMongoWriteBarrier.mjs",
  "scripts/lib/vivaGameProjectionTenantMigrationExecution.mjs",
  "scripts/lib/vivaGameProjectionTenantMigration.mjs",
  "scripts/nodered_reviewed_flow_deploy/runtime_contract.mjs",
]);
export const REMEDIATION_LIVE_EXECUTOR_SOURCE_PATHS = Object.freeze([
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
export const REMEDIATION_BUILDER_RUNTIME_PACKAGE_NAMES = Object.freeze([
  "@mongodb-js/saslprep", "bson", "memory-pager", "mongodb", "mongodb-connection-string-url",
  "punycode", "sparse-bitfield", "tr46", "webidl-conversions", "whatwg-url",
]);
const GIT_ENV = Object.freeze({
  PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
  LANG: "C",
  LC_ALL: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_OPTIONAL_LOCKS: "0",
});

const fail = (message) => { throw new Error(message); };
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const git = (repoRoot, args, encoding = "utf8") => {
  const result = spawnSync("/usr/bin/git", [
    "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args,
  ], { cwd: repoRoot, encoding, env: GIT_ENV, maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) fail(`Remediation builder Git read failed: ${args[0]}`);
  return result.stdout;
};
const committedBytes = (repoRoot, commit, relativePath) => {
  const bytes = git(repoRoot, ["show", `${commit}:${relativePath}`], null);
  if (!Buffer.isBuffer(bytes)) fail(`Remediation builder committed source is missing: ${relativePath}`);
  return bytes;
};
const writePrivate = (filePath, bytes) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const descriptor = fs.openSync(filePath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o400);
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
};
const outputParent = (argv, repoRoot) => {
  const positions = argv.reduce((items, value, index) => (value === "--output-directory" ? [...items, index] : items), []);
  if (positions.length !== 1 || !argv[positions[0] + 1]) fail("Remediation builder requires one output directory");
  const output = path.resolve(argv[positions[0] + 1]);
  if (!path.isAbsolute(argv[positions[0] + 1]) || fs.existsSync(output)) fail("Remediation output must be a new absolute path");
  const relative = path.relative(repoRoot, output);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    fail("Remediation output must be outside the repository");
  }
  const parent = path.dirname(output);
  const stat = fs.lstatSync(parent);
  const uid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
  if (fs.realpathSync(parent) !== parent || !stat.isDirectory() || stat.isSymbolicLink()
    || stat.uid !== uid || (stat.mode & 0o077) !== 0) {
    fail("Remediation output parent must be a private owned canonical directory");
  }
  return parent;
};
const makeWritable = (target) => {
  if (!fs.existsSync(target)) return;
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return;
  fs.chmodSync(target, 0o700);
  for (const entry of fs.readdirSync(target)) makeWritable(path.join(target, entry));
};
const freezeDirectories = (target) => {
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("Remediation builder snapshot directory is unsafe");
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (entry.isDirectory()) freezeDirectories(path.join(target, entry.name));
  }
  fs.chmodSync(target, 0o500);
};

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  if (argv.includes("--help")) {
    process.stdout.write("Usage: node scripts/prepare_viva_game_projection_remediation_package.mjs [exact private evidence arguments] --generated-at ISO --mutation-at ISO --operation-id ID --output-directory /private/new-package\nThe built-in bootstrap performs a fresh private SRI-verified runtime install before reading private inputs. The output is prepared only and performs no live mutation.\n");
    return null;
  }
  const repoRoot = fs.realpathSync(dependencies.repoRoot || REPO_ROOT);
  const parent = outputParent(argv, repoRoot);
  const head = String((dependencies.repository?.head?.() ?? git(repoRoot, ["rev-parse", "HEAD"]))).trim();
  const branch = String((dependencies.repository?.branch?.() ?? git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]))).trim();
  const status = String((dependencies.repository?.status?.() ?? git(repoRoot, ["status", "--porcelain"]))).trim();
  if (!COMMIT_RE.test(head) || !branch.startsWith("codex/") || status) {
    fail("Remediation builder bootstrap requires the exact clean task-branch commit");
  }
  const readCommitted = dependencies.repository?.committedBytes
    ? (relativePath) => dependencies.repository.committedBytes(head, relativePath)
    : (relativePath) => committedBytes(repoRoot, head, relativePath);
  const selfBytes = readCommitted("scripts/prepare_viva_game_projection_remediation_package.mjs");
  if (!Buffer.isBuffer(selfBytes) || sha256(selfBytes) !== sha256(fs.readFileSync(SCRIPT_PATH))) {
    fail("Remediation builder bootstrap differs from its exact committed byte stream");
  }
  const packageJsonBytes = readCommitted("package.json");
  const packageLockBytes = readCommitted("package-lock.json");
  let packageLock;
  try { packageLock = JSON.parse(packageLockBytes.toString("utf8")); }
  catch { fail("Remediation builder committed package-lock is invalid"); }
  for (const name of REMEDIATION_BUILDER_RUNTIME_PACKAGE_NAMES) {
    const locked = packageLock?.packages?.[`node_modules/${name}`];
    if (!locked?.version || !locked?.resolved?.startsWith("https://registry.npmjs.org/")
      || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(String(locked.integrity || ""))) {
      fail(`Remediation builder runtime package lacks committed registry SRI: ${name}`);
    }
  }
  const runtimeRoot = fs.mkdtempSync(path.join(parent, ".viva-remediation-builder-"));
  fs.chmodSync(runtimeRoot, 0o700);
  try {
    writePrivate(path.join(runtimeRoot, "package.json"), packageJsonBytes);
    writePrivate(path.join(runtimeRoot, "package-lock.json"), packageLockBytes);
    const npmCache = path.join(runtimeRoot, ".npm-cache");
    const npmUserConfig = path.join(runtimeRoot, "user.npmrc");
    const npmGlobalConfig = path.join(runtimeRoot, "global.npmrc");
    fs.mkdirSync(npmCache, { mode: 0o700 });
    writePrivate(npmUserConfig, Buffer.alloc(0));
    writePrivate(npmGlobalConfig, Buffer.alloc(0));
    const npmResult = dependencies.runNpmCi
      ? dependencies.runNpmCi({
        runtimeRoot, npmCache, npmUserConfig, npmGlobalConfig, packageJsonBytes, packageLockBytes,
      })
      : spawnSync("/usr/bin/npm", ["ci", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund"], {
        cwd: runtimeRoot,
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
    if (npmResult?.status !== 0) fail("Remediation builder fresh private npm ci failed");
    const executorRoot = path.join(runtimeRoot, "executor");
    fs.mkdirSync(executorRoot, { mode: 0o700 });
    const copyTree = (source, relativeTarget) => {
      const stat = fs.lstatSync(source);
      if (stat.isSymbolicLink()) fail("Remediation builder dependency snapshot contains a symlink");
      if (stat.isDirectory()) {
        const target = path.join(executorRoot, relativeTarget);
        fs.mkdirSync(target, { recursive: true, mode: 0o700 });
        for (const entry of fs.readdirSync(source)) copyTree(path.join(source, entry), path.join(relativeTarget, entry));
        return;
      }
      if (!stat.isFile() || stat.nlink !== 1) fail("Remediation builder dependency snapshot contains an unsafe file");
      const descriptor = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try { writePrivate(path.join(executorRoot, relativeTarget), fs.readFileSync(descriptor)); }
      finally { fs.closeSync(descriptor); }
    };
    for (const name of REMEDIATION_BUILDER_RUNTIME_PACKAGE_NAMES) {
      copyTree(path.join(runtimeRoot, "node_modules", name), path.join("node_modules", name));
    }
    for (const relativePath of REMEDIATION_BUILDER_SOURCE_PATHS) {
      const bytes = readCommitted(relativePath);
      writePrivate(path.join(executorRoot, relativePath), bytes);
    }
    const executorSources = REMEDIATION_LIVE_EXECUTOR_SOURCE_PATHS.map((relativePath) => {
      const bytes = readCommitted(relativePath);
      return { path: relativePath, sha256: sha256(bytes) };
    });
    freezeDirectories(executorRoot);
    const loadBuilder = dependencies.loadBuilder || ((entrypoint) => import(pathToFileURL(entrypoint).href));
    const builder = await loadBuilder(
      path.join(executorRoot, "scripts/lib/prepareVivaGameProjectionRemediationPackage.mjs"),
    );
    if (typeof builder.prepareVivaGameProjectionRemediationPackage !== "function"
      || typeof builder.collectInstalledRuntimeDependencies !== "function") {
      fail("Remediation builder snapshot entrypoint is missing");
    }
    const runtimeDependencies = builder.collectInstalledRuntimeDependencies(
      executorRoot,
      packageJsonBytes,
      packageLockBytes,
    );
    const result = builder.prepareVivaGameProjectionRemediationPackage(builder.parseArgs(argv), {
      repoRoot,
      repository: { commit: head, branch },
      executorSources,
      runtimeDependencies,
      bootstrapVerified: true,
    });
    builder.reportPreparedRemediationPackage(result);
    return result;
  } finally {
    makeWritable(runtimeRoot);
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
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
