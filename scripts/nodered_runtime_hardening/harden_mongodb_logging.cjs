#!/usr/bin/env node

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MODULE_RELATIVE_PATH = path.join(
  "node_modules",
  "@pafum",
  "node-red-node-mongodb",
  "66-mongodb.js",
);

const TARGETS = Object.freeze([
  {
    unsafe: 'console.log("MongoDB URL: " + url);',
    safe: "// MongoDB URL intentionally not logged (PadlHub runtime guard).",
  },
  {
    unsafe: 'console.log("connecting:  " + node.mongoConfig.url);',
    safe: "// MongoDB connection target intentionally not logged (PadlHub runtime guard).",
  },
]);
const LEGACY_SAFE_COMMENT = "// MongoDB URI intentionally not logged.";

function fail(message) {
  throw new Error(message);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function countOccurrences(source, needle) {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while (true) {
    const index = source.indexOf(needle, offset);
    if (index === -1) return count;
    count += 1;
    offset = index + needle.length;
  }
}

function resolveRegularFile(filePath, label) {
  const stats = fs.lstatSync(filePath);
  if (!stats.isFile() || stats.isSymbolicLink()) fail(`${label} must be a regular file`);
  return stats;
}

function resolveModulePath(userDir) {
  const absoluteUserDir = path.resolve(userDir);
  const userDirStats = fs.lstatSync(absoluteUserDir);
  if (!userDirStats.isDirectory() || userDirStats.isSymbolicLink()) {
    fail("Node-RED user directory must be a real directory");
  }
  const modulePath = path.join(absoluteUserDir, MODULE_RELATIVE_PATH);
  const moduleStats = resolveRegularFile(modulePath, "MongoDB module");
  const realUserDir = fs.realpathSync(absoluteUserDir);
  const realModulePath = fs.realpathSync(modulePath);
  const relative = path.relative(realUserDir, realModulePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    fail("MongoDB module must stay inside the Node-RED user directory");
  }
  return { modulePath: realModulePath, moduleStats };
}

function atomicWrite(filePath, contents, mode) {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.padlhub-log-guard-${process.pid}-${crypto.randomUUID()}`,
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

function inspectSource(source) {
  return TARGETS.map((target) => ({
    unsafeCount: countOccurrences(source, target.unsafe),
    safeCount: countOccurrences(source, target.safe),
  }));
}

function classifySource(source) {
  const states = inspectSource(source);
  const legacySafeCount = countOccurrences(source, LEGACY_SAFE_COMMENT);
  const normalState = legacySafeCount === 0 && states.every((state) => (
    (state.unsafeCount === 1 && state.safeCount === 0)
    || (state.unsafeCount === 0 && state.safeCount === 1)
  ));
  if (normalState) return { kind: "normal", states };
  const legacyState = legacySafeCount === TARGETS.length && states.every((state) => (
    state.unsafeCount === 0 && state.safeCount === 0
  ));
  if (legacyState) return { kind: "legacy-safe", states };
  fail("MongoDB module logging preimage is unknown; refusing to continue");
}

function hardenMongoLogging({ userDir, checkOnly = false }) {
  const { modulePath, moduleStats } = resolveModulePath(userDir);
  const before = fs.readFileSync(modulePath, "utf8");
  const beforeState = classifySource(before);
  const beforeStates = beforeState.states;

  const unsafeCount = beforeStates.reduce((total, state) => total + state.unsafeCount, 0);
  if (checkOnly && unsafeCount > 0) {
    fail("MongoDB URI logging guard is not applied");
  }

  let after = before;
  if (!checkOnly) {
    if (beforeState.kind === "legacy-safe") {
      for (const target of TARGETS) after = after.replace(LEGACY_SAFE_COMMENT, target.safe);
    }
    for (const target of TARGETS) after = after.replace(target.unsafe, target.safe);
  }
  const afterState = classifySource(after);
  const afterStates = afterState.states;
  if (checkOnly && beforeState.kind === "legacy-safe") {
    return {
      changed: false,
      moduleSha256: sha256(Buffer.from(before, "utf8")),
      guardedLoggingCallCount: TARGETS.length,
    };
  }
  if (
    afterState.kind !== "normal"
    || afterStates.some((state) => state.unsafeCount !== 0 || state.safeCount !== 1)
  ) {
    fail("MongoDB URI logging guard postcheck failed");
  }

  const changed = after !== before;
  if (changed) atomicWrite(modulePath, after, moduleStats.mode & 0o777);

  return {
    changed,
    moduleSha256: sha256(Buffer.from(after, "utf8")),
    guardedLoggingCallCount: afterStates.length,
  };
}

function parseArgs(argv) {
  let userDir = null;
  let checkOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--check") {
      checkOnly = true;
      continue;
    }
    if (value === "--user-dir") {
      userDir = argv[index + 1] || null;
      index += 1;
      continue;
    }
    fail(`Unknown argument: ${value}`);
  }
  if (!userDir) fail("Usage: harden_mongodb_logging.cjs --user-dir PATH [--check]");
  return { userDir, checkOnly };
}

if (require.main === module) {
  try {
    const result = hardenMongoLogging(parseArgs(process.argv.slice(2)));
    process.stdout.write(`changed=${result.changed}\n`);
    process.stdout.write(`moduleSha256=${result.moduleSha256}\n`);
    process.stdout.write(`guardedLoggingCallCount=${result.guardedLoggingCallCount}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  MODULE_RELATIVE_PATH,
  LEGACY_SAFE_COMMENT,
  TARGETS,
  hardenMongoLogging,
};
