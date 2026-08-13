#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_GUARD_SOURCE = path.join(SCRIPT_DIR, "harden_mongodb_logging.cjs");
const INSTALL_DIRECTORY_NAME = ".padlhub-runtime-hardening";
const INSTALLED_GUARD_NAME = "harden_mongodb_logging.cjs";
const POSTINSTALL_COMMAND = `node ./${INSTALL_DIRECTORY_NAME}/${INSTALLED_GUARD_NAME} --user-dir .`;

function fail(message) {
  throw new Error(message);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function assertRealDirectory(directoryPath, label) {
  const stats = fs.lstatSync(directoryPath);
  if (!stats.isDirectory() || stats.isSymbolicLink()) fail(`${label} must be a real directory`);
}

function assertRegularFile(filePath, label) {
  const stats = fs.lstatSync(filePath);
  if (!stats.isFile() || stats.isSymbolicLink()) fail(`${label} must be a regular file`);
  return stats;
}

function atomicWrite(filePath, contents, mode) {
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.padlhub-install-${process.pid}-${crypto.randomUUID()}`,
  );
  const descriptor = fs.openSync(
    temporaryPath,
    fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
    mode,
  );
  try {
    fs.writeFileSync(descriptor, contents);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function nextPostinstall(existing) {
  const normalized = typeof existing === "string" ? existing.trim() : "";
  if (!normalized) return POSTINSTALL_COMMAND;
  if (
    normalized === POSTINSTALL_COMMAND
    || normalized.startsWith(`${POSTINSTALL_COMMAND} && `)
  ) return normalized;
  if (normalized.includes("padlhub-runtime-hardening")) {
    fail("An unknown PadlHub runtime hardening hook already exists");
  }
  return `${POSTINSTALL_COMMAND} && ${normalized}`;
}

export function installMongoLoggingGuard({
  userDir,
  guardSource = DEFAULT_GUARD_SOURCE,
  runGuard = true,
}) {
  const absoluteUserDir = path.resolve(userDir);
  assertRealDirectory(absoluteUserDir, "Node-RED user directory");
  const packagePath = path.join(absoluteUserDir, "package.json");
  const packageStats = assertRegularFile(packagePath, "Node-RED package.json");
  assertRegularFile(guardSource, "MongoDB logging guard source");

  const installDirectory = path.join(absoluteUserDir, INSTALL_DIRECTORY_NAME);
  if (fs.existsSync(installDirectory)) {
    assertRealDirectory(installDirectory, "Runtime hardening directory");
  } else {
    fs.mkdirSync(installDirectory, { mode: 0o700 });
  }

  const installedGuardPath = path.join(installDirectory, INSTALLED_GUARD_NAME);
  if (fs.existsSync(installedGuardPath)) assertRegularFile(installedGuardPath, "Installed guard");
  const source = fs.readFileSync(guardSource);
  const previousGuard = fs.existsSync(installedGuardPath) ? fs.readFileSync(installedGuardPath) : null;
  const guardChanged = !previousGuard || !previousGuard.equals(source);
  if (guardChanged) atomicWrite(installedGuardPath, source, 0o700);
  fs.chmodSync(installedGuardPath, 0o700);

  const packageRaw = fs.readFileSync(packagePath, "utf8");
  const packageJson = JSON.parse(packageRaw);
  if (!packageJson || typeof packageJson !== "object" || Array.isArray(packageJson)) {
    fail("Node-RED package.json must contain an object");
  }
  if (packageJson.scripts !== undefined && (
    !packageJson.scripts
    || typeof packageJson.scripts !== "object"
    || Array.isArray(packageJson.scripts)
  )) {
    fail("Node-RED package.json scripts must contain an object");
  }
  packageJson.scripts = packageJson.scripts || {};
  const postinstall = nextPostinstall(packageJson.scripts.postinstall);
  const packageChanged = packageJson.scripts.postinstall !== postinstall;
  packageJson.scripts.postinstall = postinstall;
  const nextPackageRaw = `${JSON.stringify(packageJson, null, 2)}\n`;
  if (packageChanged || nextPackageRaw !== packageRaw) {
    atomicWrite(packagePath, nextPackageRaw, packageStats.mode & 0o777);
  }

  if (runGuard) {
    const result = spawnSync(
      process.execPath,
      [installedGuardPath, "--user-dir", absoluteUserDir],
      { cwd: absoluteUserDir, encoding: "utf8" },
    );
    if (result.status !== 0) {
      fail(`Installed MongoDB logging guard failed: ${String(result.stderr || "").trim()}`);
    }
  }

  return {
    guardChanged,
    packageChanged,
    guardSha256: sha256(source),
    installedGuardPath,
    packagePath,
    postinstall,
  };
}

function parseArgs(argv) {
  let userDir = null;
  let guardSource = DEFAULT_GUARD_SOURCE;
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === "--user-dir" && value) userDir = value;
    else if (key === "--guard-source" && value) guardSource = value;
    else fail(`Unknown or incomplete argument: ${key}`);
    index += 1;
  }
  if (!userDir) fail("Usage: install_mongodb_logging_guard.mjs --user-dir PATH [--guard-source PATH]");
  return { userDir, guardSource };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = installMongoLoggingGuard(parseArgs(process.argv.slice(2)));
    console.log(`guardChanged=${result.guardChanged}`);
    console.log(`packageChanged=${result.packageChanged}`);
    console.log(`guardSha256=${result.guardSha256}`);
    console.log(`postinstall=${result.postinstall}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

export {
  INSTALLED_GUARD_NAME,
  INSTALL_DIRECTORY_NAME,
  POSTINSTALL_COMMAND,
};
