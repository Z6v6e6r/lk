import assert from "node:assert/strict";
import { after, test } from "node:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { BUILD_IMAGE, buildH2IdentityAudit } from "../build_legacy_game_command_h2_identity_audit.mjs";

const suppliedTemporaryRoot = process.env.LEGACY_H2_TEST_ROOT;
if (suppliedTemporaryRoot && (!path.isAbsolute(suppliedTemporaryRoot)
  || !fs.statSync(suppliedTemporaryRoot).isDirectory() || fs.readdirSync(suppliedTemporaryRoot).length !== 0)) {
  throw new Error("LEGACY_H2_TEST_ROOT must be an absolute existing empty directory");
}
const temporaryRoot = suppliedTemporaryRoot
  ? path.resolve(suppliedTemporaryRoot)
  : fs.mkdtempSync(path.join(os.tmpdir(), "legacy-h2-identity-audit-test-"));
const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const artifactDirectory = path.join(temporaryRoot, "artifact");
const classifierDirectory = path.join(temporaryRoot, "classifier");
const cleanup = () => {
  if (suppliedTemporaryRoot) {
    fs.rmSync(artifactDirectory, { recursive: true, force: true });
    fs.rmSync(classifierDirectory, { recursive: true, force: true });
  } else {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
};
after(cleanup);
let manifest;
try {
  ({ manifest } = buildH2IdentityAudit(["--out", artifactDirectory, "--environment", "rehearsal"]));
  fs.mkdirSync(classifierDirectory, { mode: 0o700 });
  const classifierBuild = spawnSync("docker", [
    "run", "--rm", "--network", "none", "--platform", "linux/amd64",
    "--mount", "type=bind,src=" + repositoryRoot + ",dst=/repo,readonly",
    "--mount", "type=bind,src=" + classifierDirectory + ",dst=/out",
    BUILD_IMAGE, "gcc", "-static", "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
    "-o", "/out/classifier", "/repo/scripts/tests/legacy_game_command_h2_mount_classifier_harness.c",
  ], { encoding: "utf8" });
  if (classifierBuild.error || classifierBuild.status !== 0) {
    throw new Error("classifier harness build failed\nstdout:\n" + classifierBuild.stdout
      + "\nstderr:\n" + classifierBuild.stderr);
  }
} catch (error) {
  cleanup();
  throw error;
}
const binaryPath = path.join(artifactDirectory, manifest.artifact.path);
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

function runContainer(lines) {
  const result = spawnSync("docker", [
    "run", "--rm", "--network", "none", "--platform", "linux/amd64",
    "--mount", "type=bind,src=" + artifactDirectory + ",dst=/artifact,readonly",
    BUILD_IMAGE, "bash", "-euo", "pipefail", "-c", lines.join("\n"),
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, "container failed\nstdout:\n" + result.stdout + "\nstderr:\n" + result.stderr);
  return result.stdout.trim();
}

function runClassifierFixture(name, mountinfo) {
  const fixturePath = path.join(classifierDirectory, name);
  fs.writeFileSync(fixturePath, mountinfo, { mode: 0o600, flag: "wx" });
  const result = spawnSync("docker", [
    "run", "--rm", "--network", "none", "--platform", "linux/amd64",
    "--mount", "type=bind,src=" + classifierDirectory + ",dst=/fixture,readonly",
    BUILD_IMAGE, "/fixture/classifier", "/fixture/" + name,
  ], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

const rootMount = "30 1 253:1 / / rw,relatime - ext4 /dev/vda1 rw\n";
const exactAutofs = "37 26 0:32 / /proc/sys/fs/binfmt_misc rw,relatime shared:13 - autofs systemd-1 rw,fd=32\n";
const exactBinfmt = "45 37 0:35 / /proc/sys/fs/binfmt_misc rw,nosuid,nodev,noexec,relatime shared:29 - binfmt_misc binfmt_misc rw\n";

const setup = [
  "mkdir -m 0700 -p /rehearsal/custody /rehearsal/target",
  "cp /artifact/legacy-game-command-h2-identity-audit /rehearsal/custody/audit",
  "chown 0:0 /rehearsal/custody/audit",
  "chmod 0500 /rehearsal/custody/audit",
  "cd /rehearsal/custody",
  "SELF_SHA=\"$(sha256sum audit | awk '{print $1}')\"",
  "MOUNTINFO_SHA=\"$(sha256sum /proc/self/mountinfo | awk '{print $1}')\"",
  "HOSTNAME=\"$(hostname)\"",
  "BOOT_ID=\"$(cat /proc/sys/kernel/random/boot_id)\"",
  "ISSUED_AT=\"$(date +%s)\"",
  "EXPIRES_AT=$((ISSUED_AT + 600))",
  "LEASE_SHA=\"$(printf '%064d' 1)\"",
  "exec {AUDIT_FD}<audit",
];
const args = [
  "--environment rehearsal --candidate-uid 424242 --candidate-gid 424242",
  "--expected-self-sha256 \"$SELF_SHA\" --expected-mountinfo-sha256 \"$MOUNTINFO_SHA\"",
  "--expected-cwd-device 0 --expected-cwd-inode 0 --expected-cwd-mount-id 0 --expected-cwd-mount-flags 0",
  "--coverage-root /rehearsal --lease-sha256 \"$LEASE_SHA\" --expected-hostname \"$HOSTNAME\" --expected-boot-id \"$BOOT_ID\"",
  "--issued-at-unix \"$ISSUED_AT\" --expires-at-unix \"$EXPIRES_AT\"",
  "--deadline-seconds 120 --mount '/rehearsal/target|0|0|0|0|0|0|0|0000'",
].join(" ");

test("builder emits a reproducible static artifact with no mutation authority", () => {
  const binary = fs.readFileSync(binaryPath);
  const manifestText = fs.readFileSync(path.join(artifactDirectory, "manifest.json"), "utf8");
  assert.equal(binary.subarray(0, 4).toString("hex"), "7f454c46");
  assert.equal(manifest.artifact.sha256, sha256(binary));
  assert.equal(manifest.artifact.staticallyLinked, true);
  assert.equal(manifest.build.network, "none");
  assert.equal(manifest.build.image, BUILD_IMAGE);
  assert.match(manifest.build.imageId, /^sha256:[a-f0-9]{64}$/);
  assert.equal(manifest.identityMutationImplemented, false);
  assert.equal(manifest.liveMutationAuthorized, false);
  assert.deepEqual(JSON.parse(manifestText), manifest);
  assert.equal(fs.statSync(binaryPath).mode & 0o777, 0o500);
  const source = fs.readFileSync(path.join(repositoryRoot, "scripts/legacy_game_command_h2_identity_audit.c"), "utf8");
  assert.doesNotMatch(source, /\b(groupadd|useradd|usermod|userdel|groupdel|setfacl)\b/);
  assert.doesNotMatch(source.match(/pseudo_filesystem[^\n]+/)?.[0] ?? "", /"autofs"/);
  assert.match(source, /approved_autofs_placeholder/);
  assert.match(source, /AUTOFS_PLACEHOLDER_CHILD_MISSING/);
  assert.match(source, /AUTOFS_PLACEHOLDER_CHILD_AMBIGUOUS/);
  assert.match(source, /AUTOFS_PLACEHOLDER_CHILD_INVALID/);
  assert.match(source, /AUTOFS_PLACEHOLDER_AMBIGUOUS/);
  const builder = fs.readFileSync(path.join(repositoryRoot, "scripts/build_legacy_game_command_h2_identity_audit.mjs"), "utf8");
  assert.match(builder, /dst=\/src,readonly/);
  assert.match(builder, /RepoDigests/);
  assert.match(builder, /"--user", callerIdentity\(\)/);
  assert.match(builder, /process\.getuid\(\).*process\.getgid\(\)/s);
  assert.match(builder, /source snapshot changed during build/);
});

test("production mount classifier accepts only the exact systemd binfmt autofs placeholder", () => {
  assert.deepEqual(runClassifierFixture("exact.mountinfo", rootMount + exactAutofs + exactBinfmt), {
    status: 0, stdout: "scanned=1 excluded=2", stderr: "",
  });
});

test("production mount classifier rejects an exact autofs placeholder without its child", () => {
  assert.deepEqual(runClassifierFixture("missing-child.mountinfo", rootMount + exactAutofs), {
    status: 67, stdout: "", stderr: "AUTOFS_PLACEHOLDER_CHILD_MISSING",
  });
});

test("production mount classifier rejects autofs outside the exact path and source", () => {
  const wrongPath = "37 26 0:32 / /srv/data rw,relatime - autofs systemd-1 rw,fd=32\n";
  const wrongSource = "37 26 0:32 / /proc/sys/fs/binfmt_misc rw,relatime - autofs automount rw,fd=32\n";
  assert.deepEqual(runClassifierFixture("wrong-path.mountinfo", rootMount + wrongPath), {
    status: 67, stdout: "", stderr: "UNKNOWN_FILESYSTEM_REJECTED",
  });
  assert.deepEqual(runClassifierFixture("wrong-source.mountinfo", rootMount + wrongSource), {
    status: 67, stdout: "", stderr: "UNKNOWN_FILESYSTEM_REJECTED",
  });
});

test("production mount classifier binds the exact binfmt child parent and cardinality", () => {
  const wrongParent = exactBinfmt.replace("45 37", "45 99");
  const wrongChildSource = exactBinfmt.replace("binfmt_misc binfmt_misc rw", "binfmt_misc none rw");
  const secondChild = exactBinfmt.replace("45 37", "46 37");
  const unboundChild = exactBinfmt.replace("45 37", "46 99");
  const secondAutofs = exactAutofs.replace("37 26", "38 26");
  assert.deepEqual(runClassifierFixture("wrong-parent.mountinfo", rootMount + exactAutofs + wrongParent), {
    status: 67, stdout: "", stderr: "AUTOFS_PLACEHOLDER_CHILD_MISSING",
  });
  assert.deepEqual(runClassifierFixture("wrong-child-source.mountinfo", rootMount + exactAutofs + wrongChildSource), {
    status: 67, stdout: "", stderr: "AUTOFS_PLACEHOLDER_CHILD_INVALID",
  });
  assert.deepEqual(runClassifierFixture("ambiguous-child.mountinfo", rootMount + exactAutofs + exactBinfmt + secondChild), {
    status: 67, stdout: "", stderr: "AUTOFS_PLACEHOLDER_CHILD_AMBIGUOUS",
  });
  assert.deepEqual(runClassifierFixture("mixed-child.mountinfo", rootMount + exactAutofs + exactBinfmt + wrongChildSource.replace("45 37", "46 37")), {
    status: 67, stdout: "", stderr: "AUTOFS_PLACEHOLDER_CHILD_AMBIGUOUS",
  });
  assert.deepEqual(runClassifierFixture("unbound-child.mountinfo", rootMount + exactAutofs + exactBinfmt + unboundChild), {
    status: 67, stdout: "", stderr: "AUTOFS_PLACEHOLDER_CHILD_AMBIGUOUS",
  });
  assert.deepEqual(runClassifierFixture("ambiguous-autofs.mountinfo", rootMount + exactAutofs + secondAutofs + exactBinfmt), {
    status: 67, stdout: "", stderr: "AUTOFS_PLACEHOLDER_AMBIGUOUS",
  });
});

test("clean scan writes exact durable GO evidence and marker", () => {
  const output = runContainer([
    ...setup,
    "ATTEMPT=11111111-1111-4111-8111-111111111111",
    "mkdir -p /rehearsal/target/nested",
    "printf ok >/rehearsal/target/nested/file",
    "/proc/self/fd/$AUDIT_FD " + args + " --attempt-id \"$ATTEMPT\" --evidence-name \"$ATTEMPT.json\" >stdout.json",
    "cmp \"$ATTEMPT.json\" stdout.json",
    "EVIDENCE_SHA=\"$(sha256sum \"$ATTEMPT.json\" | awk '{print $1}')\"",
    "MARKER_SHA=\"$(node -e \"const fs=require('fs');console.log(JSON.parse(fs.readFileSync(process.argv[1]+'.json.complete')).evidenceSha256)\" \"$ATTEMPT\")\"",
    "printf 'sha_match=%s modes=%s/%s\\n' \"$([ \"$EVIDENCE_SHA\" = \"$MARKER_SHA\" ] && echo yes || echo no)\" \"$(stat -c %a \"$ATTEMPT.json\")\" \"$(stat -c %a \"$ATTEMPT.json.complete\")\"",
    "cat \"$ATTEMPT.json\"",
  ]);
  const lines = output.split("\n");
  assert.equal(lines[0], "sha_match=yes modes=600/600");
  const record = JSON.parse(lines[1]);
  assert.equal(record.status, "GO");
  assert.equal(record.uidOwned, 0);
  assert.equal(record.accessUserAcl, 0);
  assert.equal(record.mutationPerformed, false);
  assert.equal(record.creationAuthorized, false);
  assert.equal(record.postcheckComplete, true);
  assert.equal(record.mounts.length, 1);
  assert.ok(record.objects >= 3);
});

test("ownership and POSIX ACL collisions produce complete BLOCKED evidence", () => {
  const output = runContainer([
    ...setup,
    "ATTEMPT=22222222-2222-4222-8222-222222222222",
    "printf owned >/rehearsal/target/owned",
    "printf acl >/rehearsal/target/acl",
    "chown 424242:424242 /rehearsal/target/owned",
    "python3 -c \"import os,struct;e=[(1,7,0xffffffff),(2,4,424242),(4,5,0xffffffff),(16,5,0xffffffff),(32,5,0xffffffff)];os.setxattr('/rehearsal/target/acl','system.posix_acl_access',struct.pack('<I',2)+b''.join(struct.pack('<HHI',*x) for x in e))\"",
    "python3 -c \"import os,time;os.setgroups([424242]);open('/tmp/group-ready','w').close();time.sleep(30)\" & GROUP_PID=$!",
    "trap 'kill $GROUP_PID 2>/dev/null || true' EXIT",
    "while test ! -f /tmp/group-ready; do sleep 0.01; done",
    "set +e",
    "/proc/self/fd/$AUDIT_FD " + args + " --attempt-id \"$ATTEMPT\" --evidence-name \"$ATTEMPT.json\" >stdout.json",
    "STATUS=$?",
    "set -e",
    "cmp \"$ATTEMPT.json\" stdout.json",
    "printf 'status=%s marker=%s\\n' \"$STATUS\" \"$(test -f \"$ATTEMPT.json.complete\" && echo present)\"",
    "cat \"$ATTEMPT.json\"",
  ]);
  const lines = output.split("\n");
  assert.equal(lines[0], "status=2 marker=present");
  const record = JSON.parse(lines[1]);
  assert.equal(record.status, "BLOCKED");
  assert.equal(record.uidOwned, 1);
  assert.equal(record.gidOwned, 1);
  assert.equal(record.accessUserAcl, 1);
  assert.equal(record.processSupplementaryGidMatches, 1);
});

test("bad mount receipt and reused evidence fail closed", () => {
  const output = runContainer([
    ...setup,
    "BAD_ATTEMPT=33333333-3333-4333-8333-333333333333",
    "ONCE_ATTEMPT=44444444-4444-4444-8444-444444444444",
    "set +e",
    "/proc/self/fd/$AUDIT_FD " + args.replace("--expected-mountinfo-sha256 \"$MOUNTINFO_SHA\"", "--expected-mountinfo-sha256 \"$(printf %064d 0)\"") + " --attempt-id \"$BAD_ATTEMPT\" --evidence-name \"$BAD_ATTEMPT.json\" >/dev/null 2>&1",
    "printf 'bad=%s bad_evidence=%s\\n' \"$?\" \"$(test -e \"$BAD_ATTEMPT.json\" && echo yes || echo no)\"",
    "/proc/self/fd/$AUDIT_FD " + args + " --attempt-id \"$ONCE_ATTEMPT\" --evidence-name \"$ONCE_ATTEMPT.json\" >/dev/null",
    "/proc/self/fd/$AUDIT_FD " + args + " --attempt-id \"$ONCE_ATTEMPT\" --evidence-name \"$ONCE_ATTEMPT.json\" >/dev/null 2>&1",
    "printf 'reuse=%s complete=%s\\n' \"$?\" \"$(test -f \"$ONCE_ATTEMPT.json.complete\" && echo yes || echo no)\"",
  ]);
  assert.deepEqual(output.split("\n"), ["bad=65 bad_evidence=no", "reuse=68 complete=yes"]);
});

test("duplicate mount and deadline overflow are rejected before evidence", () => {
  const output = runContainer([
    ...setup,
    "ATTEMPT=55555555-5555-4555-8555-555555555555",
    "set +e",
    "/proc/self/fd/$AUDIT_FD " + args + " --mount '/rehearsal/target|0|0|0|0|0|0|0|0000' --attempt-id \"$ATTEMPT\" --evidence-name \"$ATTEMPT.json\" >/dev/null 2>&1",
    "printf 'duplicate=%s evidence=%s\\n' \"$?\" \"$(test -e \"$ATTEMPT.json\" && echo yes || echo no)\"",
    "OVERFLOW=66666666-6666-4666-8666-666666666666",
    "/proc/self/fd/$AUDIT_FD " + args.replace("--deadline-seconds 120", "--deadline-seconds 4294967297") + " --attempt-id \"$OVERFLOW\" --evidence-name \"$OVERFLOW.json\" >/dev/null 2>&1",
    "printf 'overflow=%s evidence=%s\\n' \"$?\" \"$(test -e \"$OVERFLOW.json\" && echo yes || echo no)\"",
  ]);
  assert.deepEqual(output.split("\n"), ["duplicate=64 evidence=no", "overflow=64 evidence=no"]);
});

test("descriptor scan fails closed during rename exchange", () => {
  const output = runContainer([
    ...setup,
    "ATTEMPT=66666666-6666-4666-8666-666666666666",
    "mkdir /rehearsal/target/a /rehearsal/target/b",
    "for n in $(seq 1 2000); do printf a >\"/rehearsal/target/a/$n\"; printf b >\"/rehearsal/target/b/$n\"; done",
    "python3 -c \"import ctypes,os;libc=ctypes.CDLL(None,use_errno=True);a=b'/rehearsal/target/a';b=b'/rehearsal/target/b';open('/tmp/exchange-ready','w').close();exec('while True:\\n libc.renameat2(-100,a,-100,b,2)')\" & EXCHANGE_PID=$!",
    "trap 'kill $EXCHANGE_PID 2>/dev/null || true' EXIT",
    "while test ! -f /tmp/exchange-ready; do sleep 0.01; done",
    "set +e",
    "/proc/self/fd/$AUDIT_FD " + args + " --attempt-id \"$ATTEMPT\" --evidence-name \"$ATTEMPT.json\" >/dev/null 2>&1",
    "STATUS=$?",
    "set -e",
    "kill $EXCHANGE_PID 2>/dev/null || true",
    "wait $EXCHANGE_PID 2>/dev/null || true",
    "printf 'status=%s evidence=%s mode=%s marker=%s\\n' \"$STATUS\" \"$(test -s \"$ATTEMPT.json\" && echo nonempty || echo empty)\" \"$(stat -c %a \"$ATTEMPT.json\")\" \"$(test -e \"$ATTEMPT.json.complete\" && echo yes || echo no)\"",
  ]);
  assert.equal(output, "status=67 evidence=empty mode=600 marker=no");
});

test("production mount classifier rejects an incomplete inventory before evidence", () => {
  const output = runContainer([
    ...setup,
    "ATTEMPT=77777777-7777-4777-8777-777777777777",
    "ROOT_DEVICE=\"$(stat -c %d /)\"",
    "ROOT_INODE=\"$(stat -c %i /)\"",
    "ROOT_MOUNT=\"$(awk '$5 == \"/\" { print $1; exit }' /proc/self/mountinfo)\"",
    "ROOT_FLAGS=\"$(python3 -c \"import ctypes;s=type('S',(ctypes.Structure,),{'_fields_':[('f_type',ctypes.c_long),('f_bsize',ctypes.c_long),('f_blocks',ctypes.c_ulong),('f_bfree',ctypes.c_ulong),('f_bavail',ctypes.c_ulong),('f_files',ctypes.c_ulong),('f_ffree',ctypes.c_ulong),('f_fsid',ctypes.c_int*2),('f_namelen',ctypes.c_long),('f_frsize',ctypes.c_long),('f_flags',ctypes.c_long),('f_spare',ctypes.c_long*4)]})();libc=ctypes.CDLL(None,use_errno=True);assert libc.statfs(b'/',ctypes.byref(s))==0;print(s.f_flags)\")\"",
    "ROOT_MAGIC_HEX=\"$(stat -fc %t /)\"",
    "ROOT_MAGIC_DEC=\"$((16#$ROOT_MAGIC_HEX))\"",
    "ROOT_MODE=\"$(stat -c %a /)\"",
    "CWD_DEVICE=\"$(stat -c %d .)\"",
    "CWD_INODE=\"$(stat -c %i .)\"",
    "set +e",
    "/proc/self/fd/$AUDIT_FD --environment production --candidate-uid 499 --candidate-gid 499"
      + " --expected-self-sha256 \"$SELF_SHA\" --expected-mountinfo-sha256 \"$MOUNTINFO_SHA\""
      + " --evidence-name \"$ATTEMPT.json\" --expected-cwd-device \"$CWD_DEVICE\" --expected-cwd-inode \"$CWD_INODE\""
      + " --expected-cwd-mount-id \"$ROOT_MOUNT\" --expected-cwd-mount-flags \"$ROOT_FLAGS\""
      + " --deadline-seconds 120 --coverage-root / --attempt-id \"$ATTEMPT\" --lease-sha256 \"$LEASE_SHA\""
      + " --expected-hostname \"$HOSTNAME\" --expected-boot-id \"$BOOT_ID\" --issued-at-unix \"$ISSUED_AT\" --expires-at-unix \"$EXPIRES_AT\""
      + " --mount \"/|$ROOT_DEVICE|$ROOT_INODE|$ROOT_MOUNT|$ROOT_FLAGS|$ROOT_MAGIC_DEC|0|0|$ROOT_MODE\" >/dev/null 2>error.txt",
    "STATUS=$?",
    "set -e",
    "printf 'status=%s evidence=%s marker=%s error=%s\\n' \"$STATUS\" \"$(test -e \"$ATTEMPT.json\" && echo yes || echo no)\" \"$(test -e \"$ATTEMPT.json.complete\" && echo yes || echo no)\" \"$(cat error.txt)\"",
  ]);
  assert.equal(output, "status=67 evidence=no marker=no error=MOUNT_COVERAGE_OMISSION");
});
