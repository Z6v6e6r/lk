import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";

import {
  POSTINSTALL_COMMAND,
  installMongoLoggingGuard,
} from "../nodered_runtime_hardening/install_mongodb_logging_guard.mjs";

const require = createRequire(import.meta.url);
const {
  MODULE_RELATIVE_PATH,
  LEGACY_SAFE_COMMENT,
  TARGETS,
  hardenMongoLogging,
} = require("../nodered_runtime_hardening/harden_mongodb_logging.cjs");

const GUARD_SOURCE = path.resolve(
  "scripts/nodered_runtime_hardening/harden_mongodb_logging.cjs",
);

function unsafeModuleSource() {
  return [
    "function connect(url, node) {",
    `  ${TARGETS[0].unsafe}`,
    `  ${TARGETS[1].unsafe}`,
    "}",
    "",
  ].join("\n");
}

function fixture({ scripts = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nodered-mongo-log-guard-"));
  const userDir = path.join(root, "userdir");
  const modulePath = path.join(userDir, MODULE_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(modulePath), { recursive: true });
  fs.writeFileSync(modulePath, unsafeModuleSource(), { mode: 0o644 });
  fs.writeFileSync(
    path.join(userDir, "package.json"),
    `${JSON.stringify({ name: "node-red-project", version: "0.0.1", scripts }, null, 2)}\n`,
    { mode: 0o644 },
  );
  return {
    root,
    userDir,
    modulePath,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("runtime guard removes both MongoDB URI logging calls and is idempotent", () => {
  const value = fixture();
  try {
    const first = hardenMongoLogging({ userDir: value.userDir });
    assert.equal(first.changed, true);
    assert.equal(first.guardedLoggingCallCount, 2);
    const hardened = fs.readFileSync(value.modulePath, "utf8");
    for (const target of TARGETS) {
      assert.equal(hardened.includes(target.unsafe), false);
      assert.equal(hardened.includes(target.safe), true);
    }

    const second = hardenMongoLogging({ userDir: value.userDir });
    assert.equal(second.changed, false);
    assert.equal(second.moduleSha256, first.moduleSha256);
    assert.doesNotThrow(() => hardenMongoLogging({ userDir: value.userDir, checkOnly: true }));
  } finally {
    value.cleanup();
  }
});

test("check-only refuses an unguarded module without changing it", () => {
  const value = fixture();
  try {
    const before = fs.readFileSync(value.modulePath, "utf8");
    assert.throws(
      () => hardenMongoLogging({ userDir: value.userDir, checkOnly: true }),
      /guard is not applied/,
    );
    assert.equal(fs.readFileSync(value.modulePath, "utf8"), before);
  } finally {
    value.cleanup();
  }
});

test("runtime guard migrates the already deployed legacy-safe comments", () => {
  const value = fixture();
  try {
    const legacySafe = unsafeModuleSource()
      .replace(TARGETS[0].unsafe, LEGACY_SAFE_COMMENT)
      .replace(TARGETS[1].unsafe, LEGACY_SAFE_COMMENT);
    fs.writeFileSync(value.modulePath, legacySafe);
    assert.doesNotThrow(() => hardenMongoLogging({ userDir: value.userDir, checkOnly: true }));
    const result = hardenMongoLogging({ userDir: value.userDir });
    assert.equal(result.changed, true);
    const hardened = fs.readFileSync(value.modulePath, "utf8");
    assert.equal(hardened.includes(LEGACY_SAFE_COMMENT), false);
    for (const target of TARGETS) assert.equal(hardened.includes(target.safe), true);
  } finally {
    value.cleanup();
  }
});

test("runtime guard fails closed on an unknown module logging preimage", () => {
  const value = fixture();
  try {
    const drifted = unsafeModuleSource().replace(
      TARGETS[1].unsafe,
      'console.info("connecting", node.mongoConfig.url);',
    );
    fs.writeFileSync(value.modulePath, drifted);
    assert.throws(
      () => hardenMongoLogging({ userDir: value.userDir }),
      /preimage is unknown/,
    );
    assert.equal(fs.readFileSync(value.modulePath, "utf8"), drifted);
  } finally {
    value.cleanup();
  }
});

test("runtime guard rejects a symlinked MongoDB module", () => {
  const value = fixture();
  try {
    const external = path.join(value.root, "external-module.js");
    fs.writeFileSync(external, unsafeModuleSource());
    fs.rmSync(value.modulePath);
    fs.symlinkSync(external, value.modulePath);
    assert.throws(
      () => hardenMongoLogging({ userDir: value.userDir }),
      /must be a regular file/,
    );
  } finally {
    value.cleanup();
  }
});

test("installer adds a durable postinstall hook, preserves scripts and reruns after reinstall", () => {
  const value = fixture({ scripts: { postinstall: "node existing-hook.cjs", test: "node --test" } });
  try {
    const installed = installMongoLoggingGuard({
      userDir: value.userDir,
      guardSource: GUARD_SOURCE,
    });
    assert.equal(installed.guardChanged, true);
    assert.equal(installed.packageChanged, true);
    const packageJson = JSON.parse(fs.readFileSync(path.join(value.userDir, "package.json"), "utf8"));
    assert.equal(
      packageJson.scripts.postinstall,
      `${POSTINSTALL_COMMAND} && node existing-hook.cjs`,
    );
    assert.equal(packageJson.scripts.test, "node --test");
    assert.equal(fs.statSync(installed.installedGuardPath).mode & 0o777, 0o700);

    fs.writeFileSync(value.modulePath, unsafeModuleSource());
    const lifecycle = spawnSync(
      process.execPath,
      [installed.installedGuardPath, "--user-dir", value.userDir],
      { cwd: value.userDir, encoding: "utf8" },
    );
    assert.equal(lifecycle.status, 0, lifecycle.stderr);
    assert.doesNotThrow(() => hardenMongoLogging({ userDir: value.userDir, checkOnly: true }));

    const repeated = installMongoLoggingGuard({
      userDir: value.userDir,
      guardSource: GUARD_SOURCE,
    });
    assert.equal(repeated.guardChanged, false);
    assert.equal(repeated.packageChanged, false);
  } finally {
    value.cleanup();
  }
});

test("installer refuses an unknown pre-existing PadlHub hardening hook", () => {
  const value = fixture({ scripts: { postinstall: "node ./.padlhub-runtime-hardening/other.cjs" } });
  try {
    assert.throws(
      () => installMongoLoggingGuard({
        userDir: value.userDir,
        guardSource: GUARD_SOURCE,
        runGuard: false,
      }),
      /unknown PadlHub runtime hardening hook/,
    );
  } finally {
    value.cleanup();
  }
});

test("147 installer scripts preserve the narrow production safety contract", () => {
  const localInstaller = fs.readFileSync(
    "scripts/install_nodered_mongodb_logging_guard_147.sh",
    "utf8",
  );
  const remoteInstaller = fs.readFileSync(
    "scripts/nodered_runtime_hardening/install_mongodb_logging_guard_147_remote.sh",
    "utf8",
  );
  assert.match(localInstaller, /host="lk-primary-147"/);
  assert.match(localInstaller, /publicGamesApiStatus/);
  assert.match(remoteInstaller, /--disable-warning=DEP0170/);
  assert.match(remoteInstaller, /' -- "\$expected_node_arg"/);
  assert.match(remoteInstaller, /pm2 save/);
  assert.match(remoteInstaller, /mongodbUrisRemaining/);
  assert.match(remoteInstaller, /flow_sha_after.*flow_sha_before/);
  assert.match(remoteInstaller, /package_backup/);
  assert.match(remoteInstaller, /module_backup/);
  assert.doesNotMatch(localInstaller, /rm -rf/);
  assert.doesNotMatch(remoteInstaller, /rm -rf/);

  const nodeArgumentProbe = spawnSync(
    process.execPath,
    ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", "--", "--disable-warning=DEP0170"],
    { encoding: "utf8" },
  );
  assert.equal(nodeArgumentProbe.status, 0, nodeArgumentProbe.stderr);
  assert.deepEqual(JSON.parse(nodeArgumentProbe.stdout), ["--disable-warning=DEP0170"]);
});
