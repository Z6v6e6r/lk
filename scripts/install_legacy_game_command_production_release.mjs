#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PRODUCTION_ROOT = "/opt/padlhub/legacy-game-command";
const PRODUCTION_MIGRATION_ID = "legacy-game-command-prerequisites-production-v1";
const INSTALL_CONFIRMATION = "INSTALL_LEGACY_GAME_COMMAND_PRODUCTION_RELEASE_V1";
const INSTALLER_RELATIVE_PATH = "scripts/install_legacy_game_command_production_release.mjs";
const INSTALLER_PATH = fileURLToPath(import.meta.url);
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 128 * 1024 * 1024;
const MAX_BUNDLE_FILES = 10_000;
const SOURCE_KEYS = Object.freeze([
  "liveFlowSha256", "candidateFlowSha256", "packageSha256", "writerRegistrySha256",
  "installerSha256", "runnerSha256", "migrationCoreSha256", "approvalVerifierSha256", "trustAnchorManifestSha256",
  "rootPackageSha256", "dependencyLockSha256", "nodeExecutableSha256", "mongodbRuntimeClosureSha256",
]);
const sha256 = (body) => crypto.createHash("sha256").update(body).digest("hex");
const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
};
const canonicalJson = (value) => `${JSON.stringify(stableValue(value))}\n`;

function parseCanonicalJson(body, label) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  if (canonicalJson(value) !== text) throw new Error(`${label} is not canonical JSON`);
  return value;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) args[argv[index]] = argv[index + 1];
  if (!args["--mode"] || !args["--bundle"] || !args["--install-root"]
    || !args["--executor-uid"] || !args["--expected-commit"]
    || !args["--expected-manifest-sha256"] || !args["--expected-installer-sha256"]) {
    throw new Error("Usage: --mode plan|install --bundle /absolute/release --install-root /absolute/root --executor-uid UID --expected-commit SHA --expected-manifest-sha256 SHA --expected-installer-sha256 SHA [--environment production|rehearsal --deployment-id UUID --activated-at RFC3339]");
  }
  return args;
}

function listFiles(root, { excludeManifest = false } = {}) {
  const result = [];
  let totalSize = 0;
  const visit = (directory) => {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe release directory: ${directory}`);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Release bundle contains symlink: ${absolute}`);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) {
        const fileStat = fs.statSync(absolute);
        if (fileStat.nlink !== 1) throw new Error(`Release bundle file must have one link: ${absolute}`);
        totalSize += fileStat.size;
        if (fileStat.size > MAX_BUNDLE_BYTES || totalSize > MAX_BUNDLE_BYTES
          || result.length >= MAX_BUNDLE_FILES) {
          throw new Error("Release bundle exceeds the approved size or file-count boundary");
        }
        const relative = path.relative(root, absolute);
        if (!(excludeManifest && relative === "release-manifest.json")) {
          result.push({ path: relative, size: fileStat.size, sha256: sha256(fs.readFileSync(absolute)) });
        }
      } else throw new Error(`Release bundle contains unsupported entry: ${absolute}`);
    }
  };
  visit(root);
  return result;
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} schema mismatch`);
  }
}

export function verifyLegacyGameCommandReleaseBundle(bundlePath) {
  const bundle = fs.realpathSync(bundlePath);
  const manifestPath = path.join(bundle, "release-manifest.json");
  const manifestStat = fs.lstatSync(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.nlink !== 1
    || manifestStat.size === 0 || manifestStat.size > MAX_MANIFEST_BYTES) {
    throw new Error("Release manifest is not a bounded single-link regular file");
  }
  const manifestBody = fs.readFileSync(manifestPath);
  const manifest = parseCanonicalJson(manifestBody, "Legacy command release manifest");
  exactKeys(manifest, ["schemaVersion", "migrationId", "repositoryCommit", "source", "files"], "Release manifest");
  if (manifest.schemaVersion !== 1 || manifest.migrationId !== PRODUCTION_MIGRATION_ID
    || !COMMIT_PATTERN.test(String(manifest.repositoryCommit || "")) || !Array.isArray(manifest.files)) {
    throw new Error("Release manifest identity mismatch");
  }
  exactKeys(manifest.source, SOURCE_KEYS, "Release manifest source");
  for (const [key, value] of Object.entries(manifest.source)) {
    if (!HASH_PATTERN.test(String(value || ""))) throw new Error(`Release manifest ${key} is invalid`);
  }
  const expectedFiles = [...manifest.files].sort((a, b) => a.path.localeCompare(b.path));
  for (const item of expectedFiles) {
    exactKeys(item, ["path", "size", "sha256"], "Release manifest file");
    if (!item.path || path.isAbsolute(item.path) || item.path.split(path.sep).includes("..")
      || !Number.isSafeInteger(item.size) || item.size < 0 || !HASH_PATTERN.test(String(item.sha256 || ""))) {
      throw new Error("Release manifest file entry is invalid");
    }
  }
  const actualFiles = listFiles(bundle, { excludeManifest: true })
    .sort((a, b) => a.path.localeCompare(b.path));
  if (canonicalJson(expectedFiles) !== canonicalJson(actualFiles)) throw new Error("Release bundle inventory mismatch");
  const installer = actualFiles.find((item) => item.path === INSTALLER_RELATIVE_PATH);
  if (!installer || installer.sha256 !== manifest.source.installerSha256) {
    throw new Error("Release installer is absent from or differs from the authenticated source identity");
  }
  return { bundle, manifest, manifestSha256: sha256(manifestBody) };
}

function assertTrustedBootstrap(verified, expectedInstallerSha256) {
  const expectedPath = fs.realpathSync(path.join(verified.bundle, INSTALLER_RELATIVE_PATH));
  const actualPath = fs.realpathSync(INSTALLER_PATH);
  const actualSha256 = sha256(fs.readFileSync(actualPath));
  if (!HASH_PATTERN.test(String(expectedInstallerSha256 || ""))
    || expectedInstallerSha256 !== verified.manifest.source.installerSha256
    || expectedInstallerSha256 !== actualSha256) {
    throw new Error("Release installer does not match the independently expected installer digest");
  }
  if (actualPath !== expectedPath) {
    throw new Error("Release installer must execute from inside the authenticated release bundle");
  }
  return actualSha256;
}

function assertSafeParent(directory, expectedUid) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== expectedUid || (stat.mode & 0o022) !== 0) {
    throw new Error(`Install parent is not custodian-owned and protected: ${directory}`);
  }
}

function copyBundle(sourceRoot, targetRoot) {
  fs.mkdirSync(targetRoot, { mode: 0o700 });
  for (const item of listFiles(sourceRoot)) {
    const source = path.join(sourceRoot, item.path);
    const target = path.join(targetRoot, item.path);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(target, 0o444);
  }
}

function sealDirectories(root) {
  const directories = [];
  const visit = (directory) => {
    directories.push(directory);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) visit(path.join(directory, entry.name));
    }
  };
  visit(root);
  directories.sort((a, b) => b.length - a.length).forEach((directory) => fs.chmodSync(directory, 0o555));
}

function removePrivateStaging(root) {
  const makeWritable = (target) => {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) throw new Error(`Refusing to clean symlinked staging entry: ${target}`);
    if (stat.isDirectory()) {
      fs.chmodSync(target, 0o700);
      for (const entry of fs.readdirSync(target)) makeWritable(path.join(target, entry));
    } else if (stat.isFile()) fs.chmodSync(target, 0o600);
    else throw new Error(`Refusing to clean unsupported staging entry: ${target}`);
  };
  makeWritable(root);
  fs.rmSync(root, { recursive: true, force: true });
}

async function loadVerifiedRunner(root) {
  const runnerPath = path.join(root, "scripts/run_legacy_game_command_production_migration.mjs");
  return import(`${pathToFileURL(runnerPath).href}?verified=${sha256(fs.readFileSync(runnerPath))}`);
}

function recomputeInstalledSource(root, runner) {
  return {
    liveFlowSha256: runner.EXPECTED_LIVE_FLOW_SHA256,
    candidateFlowSha256: runner.EXPECTED_CANDIDATE_FLOW_SHA256,
    packageSha256: runner.hashPrivatePackage(path.join(root, "node-red/custom-nodes/legacy-game-command-transaction")),
    writerRegistrySha256: sha256(fs.readFileSync(path.join(root, "scripts/legacy_game_revision_writers.json"))),
    installerSha256: sha256(fs.readFileSync(path.join(root, INSTALLER_RELATIVE_PATH))),
    runnerSha256: sha256(fs.readFileSync(path.join(root, "scripts/run_legacy_game_command_production_migration.mjs"))),
    migrationCoreSha256: sha256(fs.readFileSync(path.join(root, "scripts/migrate_legacy_game_command_prerequisites.mjs"))),
    approvalVerifierSha256: sha256(fs.readFileSync(path.join(root, "scripts/lib/legacy_game_command_production_approval.mjs"))),
    trustAnchorManifestSha256: sha256(fs.readFileSync(path.join(root, "scripts/legacy_game_command_production_trust_anchor.json"))),
    rootPackageSha256: sha256(fs.readFileSync(path.join(root, "package.json"))),
    dependencyLockSha256: sha256(fs.readFileSync(path.join(root, "package-lock.json"))),
    nodeExecutableSha256: sha256(fs.readFileSync(process.execPath)),
    mongodbRuntimeClosureSha256: runner.hashRuntimePackageClosure(path.join(root, "node_modules/mongodb/package.json")),
  };
}

export function verifySealedRelease(root, custodianUid) {
  const visit = (target) => {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || stat.uid !== custodianUid) {
      throw new Error(`Installed release custody verification failed: ${target}`);
    }
    if (stat.isDirectory()) {
      if ((stat.mode & 0o777) !== 0o555) {
        throw new Error(`Installed release directory mode is not 0555: ${target}`);
      }
      for (const entry of fs.readdirSync(target)) visit(path.join(target, entry));
    } else if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o444) {
      throw new Error(`Installed release file mode or identity is unsafe: ${target}`);
    }
  };
  visit(root);
}

export async function prepareLegacyGameCommandReleaseInstall({
  mode,
  bundlePath,
  installRoot,
  executorUid,
  expectedCommit,
  expectedManifestSha256,
  expectedInstallerSha256,
  environment = "production",
  deploymentId,
  activatedAt,
  currentUid = typeof process.getuid === "function" ? process.getuid() : -1,
} = {}) {
  if (!new Set(["plan", "install"]).has(mode)) throw new Error("Install mode must be plan or install");
  const verified = verifyLegacyGameCommandReleaseBundle(bundlePath);
  const installerSha256 = assertTrustedBootstrap(verified, expectedInstallerSha256);
  const root = path.resolve(String(installRoot || ""));
  const executor = Number(executorUid);
  if (!COMMIT_PATTERN.test(String(expectedCommit || ""))
    || expectedCommit !== verified.manifest.repositoryCommit) {
    throw new Error("Release bundle does not match the independently expected commit");
  }
  if (!HASH_PATTERN.test(String(expectedManifestSha256 || ""))
    || expectedManifestSha256 !== verified.manifestSha256) {
    throw new Error("Release bundle does not match the independently expected manifest digest");
  }
  if (!path.isAbsolute(root) || !Number.isSafeInteger(executor) || executor < 1 || executor === currentUid) {
    throw new Error("Install root or separate executor UID is invalid");
  }
  const releaseDir = path.join(root, "releases", verified.manifest.repositoryCommit);
  const result = {
    mode,
    environment,
    repositoryCommit: verified.manifest.repositoryCommit,
    bundleManifestSha256: verified.manifestSha256,
    installerSha256,
    releaseDir,
    deploymentPerformed: false,
  };
  if (mode === "plan") return result;

  if (environment === "production") {
    if (currentUid !== 0 || root !== PRODUCTION_ROOT
      || process.env.LK_LEGACY_COMMAND_RELEASE_INSTALL !== INSTALL_CONFIRMATION) {
      throw new Error("Production install requires root, exact install root, and explicit confirmation");
    }
  } else if (environment !== "rehearsal") {
    throw new Error("Install environment must be production or rehearsal");
  }
  if (!UUID_PATTERN.test(String(deploymentId || ""))) throw new Error("Deployment ID must be a UUID");
  const activated = new Date(String(activatedAt || ""));
  if (!Number.isFinite(activated.getTime()) || activated.toISOString() !== activatedAt || activated.getTime() > Date.now()) {
    throw new Error("Activation timestamp must be a canonical non-future timestamp");
  }
  if (fs.existsSync(releaseDir) || (fs.existsSync(root) && fs.lstatSync(root).isSymbolicLink())) {
    throw new Error("Release target already exists or install root is unsafe");
  }

  const custodianUid = currentUid;
  const rootParent = path.dirname(root);
  assertSafeParent(rootParent, custodianUid);
  if (!fs.existsSync(root)) fs.mkdirSync(root, { mode: 0o755 });
  assertSafeParent(root, custodianUid);
  const releases = path.join(root, "releases");
  if (!fs.existsSync(releases)) fs.mkdirSync(releases, { mode: 0o755 });
  assertSafeParent(releases, custodianUid);

  const staging = path.join(releases, `.staging-${deploymentId}`);
  if (fs.existsSync(staging)) throw new Error("Release staging target already exists");
  try {
    copyBundle(verified.bundle, staging);
    const copied = verifyLegacyGameCommandReleaseBundle(staging);
    if (copied.manifestSha256 !== verified.manifestSha256) {
      throw new Error("Release manifest changed while the bundle was copied");
    }
    const runner = await loadVerifiedRunner(staging);
    const source = recomputeInstalledSource(staging, runner);
    const portableSource = { ...source };
    const portableManifestSource = { ...verified.manifest.source };
    delete portableSource.nodeExecutableSha256;
    delete portableManifestSource.nodeExecutableSha256;
    if (canonicalJson(portableSource) !== canonicalJson(portableManifestSource)) {
      throw new Error("Release source identity does not match the copied bundle");
    }
    const attestation = {
      schemaVersion: 1,
      migrationId: PRODUCTION_MIGRATION_ID,
      environment,
      deploymentId,
      repositoryCommit: verified.manifest.repositoryCommit,
      source,
      activatedAt,
      status: "ACTIVE",
    };
    fs.writeFileSync(path.join(staging, "release-attestation.json"), canonicalJson(attestation), { mode: 0o444, flag: "wx" });
    sealDirectories(staging);
    verifySealedRelease(staging, custodianUid);
    fs.renameSync(staging, releaseDir);
  } catch (error) {
    if (fs.existsSync(staging)) removePrivateStaging(staging);
    throw error;
  }
  return { ...result, deploymentPerformed: true, releaseAttestationPath: path.join(releaseDir, "release-attestation.json") };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await prepareLegacyGameCommandReleaseInstall({
      mode: args["--mode"],
      bundlePath: args["--bundle"],
      installRoot: args["--install-root"],
      executorUid: args["--executor-uid"],
      expectedCommit: args["--expected-commit"],
      expectedManifestSha256: args["--expected-manifest-sha256"],
      expectedInstallerSha256: args["--expected-installer-sha256"],
      environment: args["--environment"] || "production",
      deploymentId: args["--deployment-id"],
      activatedAt: args["--activated-at"],
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
