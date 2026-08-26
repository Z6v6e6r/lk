import assert from "node:assert/strict";
import { after, test } from "node:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  BUILD_IMAGE,
  buildRootAclBootstrap,
} from "../build_legacy_game_command_root_acl_bootstrap.mjs";

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-root-acl-bootstrap-test-"));
const artifactDirectory = path.join(temporaryRoot, "artifact");
const { manifest } = buildRootAclBootstrap([
  "--out", artifactDirectory,
  "--environment", "rehearsal",
]);
const binaryPath = path.join(artifactDirectory, manifest.artifact.path);

after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function runContainer(script) {
  const result = spawnSync("docker", [
    "run", "--rm", "--network", "none", "--platform", "linux/amd64",
    "--mount", `type=bind,src=${artifactDirectory},dst=/artifact,readonly`,
    BUILD_IMAGE, "bash", "-euo", "pipefail", "-c", script,
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, `container failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result.stdout.trim();
}

const setup = String.raw`
mkdir -m 0700 -p /rehearsal/custody
cp /artifact/legacy-game-command-root-acl-bootstrap /rehearsal/custody/bootstrap
chown 0:0 /rehearsal/custody/bootstrap
chmod 0500 /rehearsal/custody/bootstrap
cd /rehearsal/custody
SELF_SHA="$(sha256sum bootstrap | awk '{print $1}')"
CWD_DEVICE="$(stat -c %d .)"
CWD_INODE="$(stat -c %i .)"
exec {BOOTSTRAP_FD}<bootstrap
`;

const mutationArgs = String.raw`--environment rehearsal --target /rehearsal/target \
  --expected-self-sha256 "$SELF_SHA" \
  --expected-cwd-device "$CWD_DEVICE" --expected-cwd-inode "$CWD_INODE" \
  --expected-target-device "$TARGET_DEVICE" --expected-target-inode "$TARGET_INODE"`;

test("builder emits a reproducible, static amd64 artifact and canonical manifest", () => {
  const binary = fs.readFileSync(binaryPath);
  const manifestText = fs.readFileSync(path.join(artifactDirectory, "manifest.json"), "utf8");
  assert.equal(binary.subarray(0, 4).toString("hex"), "7f454c46");
  assert.equal(manifest.artifact.sha256, sha256(binary));
  assert.equal(manifest.artifact.staticallyLinked, true);
  assert.equal(manifest.build.network, "none");
  assert.equal(manifest.build.reproducibleDoubleBuild, true);
  assert.equal(manifest.liveMutationAuthorized, false);
  assert.deepEqual(JSON.parse(manifestText), manifest);
  assert.equal(fs.statSync(binaryPath).mode & 0o777, 0o500);
  assert.throws(
    () => buildRootAclBootstrap(["--out", "/tmp/a", "--out", "/tmp/b", "--environment", "rehearsal"]),
    /duplicate argument/,
  );
  assert.throws(
    () => buildRootAclBootstrap(["--out", "/tmp/a", "--environment", "rehearsal", "--extra", "value"]),
    /unknown argument/,
  );
});

test("audit, apply, and rollback preserve one opened inode and exact modes", () => {
  const output = runContainer(`${setup}
mkdir -m 0707 /rehearsal/target
TARGET_DEVICE="$(stat -c %d /rehearsal/target)"
TARGET_INODE="$(stat -c %i /rehearsal/target)"
/proc/self/fd/$BOOTSTRAP_FD --mode audit --environment rehearsal \
  --target /rehearsal/target --expected-self-sha256 "$SELF_SHA"
LK_ROOT_ACL_BOOTSTRAP_REHEARSAL=MUTATE_REHEARSAL_TARGET_V1 \
  /proc/self/fd/$BOOTSTRAP_FD --mode apply ${mutationArgs} --expected-mode 0707 --target-mode 0755
LK_ROOT_ACL_BOOTSTRAP_REHEARSAL=MUTATE_REHEARSAL_TARGET_V1 \
  /proc/self/fd/$BOOTSTRAP_FD --mode rollback ${mutationArgs} --expected-mode 0755 --target-mode 0707
`);
  const records = output.split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(records.map((record) => record.mutationPerformed), [false, true, true]);
  assert.deepEqual(records.map((record) => record.before.mode), ["0707", "0707", "0755"]);
  assert.deepEqual(records.map((record) => record.after.mode), ["0707", "0755", "0707"]);
  assert.ok(records.every((record) => record.before.inode === records[0].before.inode));
  assert.ok(records.every((record) => record.postcheckComplete === true));
});

test("mutation rejects missing authority, identity drift, xattrs, symlinks, aliases, and duplicate arguments", () => {
  const output = runContainer(`${setup}
mkdir -m 0707 /rehearsal/target
TARGET_DEVICE="$(stat -c %d /rehearsal/target)"
TARGET_INODE="$(stat -c %i /rehearsal/target)"
set +e
/proc/self/fd/$BOOTSTRAP_FD --mode apply ${mutationArgs} --expected-mode 0707 --target-mode 0755 >/dev/null 2>&1
printf 'missing=%s\n' "$?"
LK_ROOT_ACL_BOOTSTRAP_REHEARSAL=MUTATE_REHEARSAL_TARGET_V1 \
  /proc/self/fd/$BOOTSTRAP_FD --mode apply ${mutationArgs} --expected-target-inode 1 --expected-mode 0707 --target-mode 0755 >/dev/null 2>&1
printf 'duplicate=%s\n' "$?"
LK_ROOT_ACL_BOOTSTRAP_REHEARSAL=MUTATE_REHEARSAL_TARGET_V1 \
  /proc/self/fd/$BOOTSTRAP_FD --mode apply --environment rehearsal --target /rehearsal/target \
  --expected-self-sha256 "$SELF_SHA" \
  --expected-cwd-device "$CWD_DEVICE" --expected-cwd-inode "$CWD_INODE" \
  --expected-target-device "$TARGET_DEVICE" --expected-target-inode 1 \
  --expected-mode 0707 --target-mode 0755 >/dev/null 2>&1
printf 'identity=%s\n' "$?"
python3 -c "import os; os.setxattr('/rehearsal/target', b'user.blocked', b'1')"
/proc/self/fd/$BOOTSTRAP_FD --mode audit --environment rehearsal \
  --target /rehearsal/target --expected-self-sha256 "$SELF_SHA" >/dev/null 2>&1
printf 'xattr=%s\n' "$?"
python3 -c "import os; os.removexattr('/rehearsal/target', b'user.blocked')"
mv /rehearsal/target /rehearsal/real
ln -s /rehearsal/real /rehearsal/target
/proc/self/fd/$BOOTSTRAP_FD --mode audit --environment rehearsal \
  --target /rehearsal/target --expected-self-sha256 "$SELF_SHA" >/dev/null 2>&1
printf 'symlink=%s\n' "$?"
/proc/self/fd/$BOOTSTRAP_FD --mode audit --environment production \
  --target /rehearsal/real --expected-self-sha256 "$SELF_SHA" >/dev/null 2>&1
printf 'alias=%s\n' "$?"
printf 'mode=%s\n' "$(stat -c %a /rehearsal/real)"
`);
  assert.deepEqual(Object.fromEntries(output.split("\n").map((line) => line.split("="))), {
    missing: "65",
    duplicate: "64",
    identity: "65",
    xattr: "67",
    symlink: "65",
    alias: "64",
    mode: "707",
  });
});

test("path replacement during pause mutates only the already opened inode", () => {
  const output = runContainer(`${setup}
mkdir -m 0707 /rehearsal/target
TARGET_DEVICE="$(stat -c %d /rehearsal/target)"
TARGET_INODE="$(stat -c %i /rehearsal/target)"
LK_ROOT_ACL_BOOTSTRAP_REHEARSAL=MUTATE_REHEARSAL_TARGET_V1 \
  /proc/self/fd/$BOOTSTRAP_FD --mode apply ${mutationArgs} --expected-mode 0707 --target-mode 0755 \
  --rehearsal-pause-ms 1000 >/tmp/result.json &
PID=$!
sleep 0.2
mv /rehearsal/target /rehearsal/opened-target
mkdir -m 0707 /rehearsal/target
wait "$PID"
cat /tmp/result.json
printf 'opened=%s replacement=%s\n' "$(stat -c %a /rehearsal/opened-target)" "$(stat -c %a /rehearsal/target)"
`);
  const lines = output.split("\n");
  const record = JSON.parse(lines[0]);
  assert.equal(record.mutationPerformed, true);
  assert.equal(record.before.inode, record.after.inode);
  assert.equal(record.after.mode, "0755");
  assert.equal(lines[1], "opened=755 replacement=707");
});
