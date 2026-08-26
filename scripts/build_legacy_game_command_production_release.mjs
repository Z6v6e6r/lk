#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { canonicalJson, PRODUCTION_MIGRATION_ID } from "./lib/legacy_game_command_production_approval.mjs";
import {
  assertPinnedMongoRuntimeClosure,
  buildProductionStaticSourceIdentity,
  resolveRuntimePackageClosure,
} from "./run_legacy_game_command_production_migration.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(SCRIPT_DIR);
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

export const RELEASE_SOURCE_FILES = Object.freeze([
  "package.json",
  "package-lock.json",
  "scripts/run_legacy_game_command_production_migration.mjs",
  "scripts/migrate_legacy_game_command_prerequisites.mjs",
  "scripts/audit_legacy_game_revision_writers.mjs",
  "scripts/legacy_game_revision_writers.json",
  "scripts/legacy_game_command_production_trust_anchor.json",
  "scripts/lib/legacy_game_command_production_approval.mjs",
  "node-red/custom-nodes/legacy-game-command-transaction/package.json",
  "node-red/custom-nodes/legacy-game-command-transaction/legacy-game-command-core.mjs",
  "node-red/custom-nodes/legacy-game-command-transaction/legacy-game-command-node.cjs",
  "node-red/custom-nodes/legacy-game-command-transaction/legacy-game-command-node.html",
]);

const sha256 = (body) => crypto.createHash("sha256").update(body).digest("hex");

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) args[argv[index]] = argv[index + 1];
  if (!args["--out"]) throw new Error("Usage: --out /absolute/new-release-directory");
  return args;
}

function gitIdentity(root) {
  const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  const status = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
  const repositoryCommit = revision.status === 0 ? revision.stdout.trim() : "";
  if (!COMMIT_PATTERN.test(repositoryCommit)) throw new Error("Release build requires an exact Git commit");
  if (status.status !== 0 || status.stdout.trim()) throw new Error("Release build requires a clean worktree");
  return repositoryCommit;
}

function copyRuntimeFile(source, target) {
  const stat = fs.lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error(`Release source must be a single-link regular file: ${source}`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(target, 0o600);
}

export function readGitBlob(root, commit, relative) {
  const treeEntry = spawnSync("git", ["ls-tree", commit, "--", relative], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  const fields = treeEntry.status === 0 ? treeEntry.stdout.trim().split(/\s+/) : [];
  if (fields[0] !== "100644" || fields[1] !== "blob") {
    throw new Error(`Release source is not an exact regular Git blob: ${relative}`);
  }
  const blob = spawnSync("git", ["show", `${commit}:${relative}`], {
    cwd: root,
    encoding: null,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (blob.status !== 0 || !Buffer.isBuffer(blob.stdout)) {
    throw new Error(`Unable to read exact release source from Git: ${relative}`);
  }
  return blob.stdout;
}

function copyGitBlob(root, commit, relative, target) {
  const body = readGitBlob(root, commit, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, body, { mode: 0o600, flag: "wx" });
}

function runtimeRelativePath(directory) {
  const marker = `${path.sep}node_modules${path.sep}`;
  const index = directory.indexOf(marker);
  if (index < 0) throw new Error(`Runtime package is outside node_modules: ${directory}`);
  const relative = `node_modules/${directory.slice(index + marker.length)}`;
  if (relative.split(path.sep).includes("..")) throw new Error(`Runtime package path is unsafe: ${directory}`);
  return relative;
}

function copyRuntimePackage(packageDirectory, targetRoot) {
  const relativeRoot = runtimeRelativePath(packageDirectory);
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const source = path.join(current, entry.name);
      const target = path.join(targetRoot, relativeRoot, path.relative(packageDirectory, source));
      if (entry.isSymbolicLink()) throw new Error(`Runtime package contains symlink: ${source}`);
      if (entry.isDirectory()) visit(source);
      else if (entry.isFile()) copyRuntimeFile(source, target);
      else throw new Error(`Runtime package contains unsupported entry: ${source}`);
    }
  };
  visit(packageDirectory);
}

function assertRuntimeMatchesLock(runtimePackages, repositoryRoot) {
  const lock = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package-lock.json"), "utf8"));
  if (lock.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== "object") {
    throw new Error("Release build requires a package-lock v3 package inventory");
  }
  for (const runtimePackage of runtimePackages) {
    const relative = runtimeRelativePath(runtimePackage.directory);
    const installed = JSON.parse(fs.readFileSync(path.join(runtimePackage.directory, "package.json"), "utf8"));
    const locked = lock.packages[relative];
    if (!locked || locked.version !== installed.version
      || runtimePackage.identity !== `${installed.name}@${installed.version}`) {
      throw new Error(`Installed runtime package does not match package-lock: ${runtimePackage.identity}`);
    }
  }
}

function inventory(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Release contains symlink: ${absolute}`);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) {
        const relative = path.relative(root, absolute);
        files.push({ path: relative, size: fs.statSync(absolute).size, sha256: sha256(fs.readFileSync(absolute)) });
      } else throw new Error(`Release contains unsupported entry: ${absolute}`);
    }
  };
  visit(root);
  return files;
}

export function buildLegacyGameCommandProductionRelease({
  outDir,
} = {}) {
  const root = fs.realpathSync(REPO_ROOT);
  const output = path.resolve(String(outDir || ""));
  if (!path.isAbsolute(output) || fs.existsSync(output)) {
    throw new Error("Release output must be a new absolute path");
  }
  const commit = gitIdentity(root);

  fs.mkdirSync(output, { mode: 0o700 });
  try {
    for (const relative of RELEASE_SOURCE_FILES) copyGitBlob(root, commit, relative, path.join(output, relative));
    const require = createRequire(path.join(root, "package.json"));
    const mongodbManifest = require.resolve("mongodb/package.json");
    const runtimePackages = resolveRuntimePackageClosure(mongodbManifest);
    assertRuntimeMatchesLock(runtimePackages, output);
    assertPinnedMongoRuntimeClosure(mongodbManifest);
    for (const runtimePackage of runtimePackages) copyRuntimePackage(runtimePackage.directory, output);
    const source = buildProductionStaticSourceIdentity({ sourceRoot: output });
    if (source.releaseAttestationSha256 !== "UNBOUND") throw new Error("Builder source must not claim an attestation");
    delete source.releaseAttestationSha256;
    for (const value of Object.values(source)) {
      if (!HASH_PATTERN.test(value)) throw new Error("Builder produced an invalid source digest");
    }
    const manifest = {
      schemaVersion: 1,
      migrationId: PRODUCTION_MIGRATION_ID,
      repositoryCommit: commit,
      source,
      files: inventory(output),
    };
    fs.writeFileSync(path.join(output, "release-manifest.json"), canonicalJson(manifest), { mode: 0o600, flag: "wx" });
    return { outDir: output, ...manifest };
  } catch (error) {
    fs.rmSync(output, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    console.log(JSON.stringify(buildLegacyGameCommandProductionRelease({ outDir: args["--out"] })));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
