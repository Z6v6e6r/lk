// Executed only by the test-owned Node copy; never included in an install bundle.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { launchStoppedCandidate } from "../../launch_lk1_subscription_dev_stopped_candidate.mjs";

const input = JSON.parse(fs.readFileSync(0, "utf8"));
const runtime = fs.realpathSync(process.execPath);
const stat = fs.lstatSync(runtime);
assert.equal(runtime, fs.realpathSync(input.runtime));
assert.equal(stat.isFile(), true);
assert.equal(stat.isSymbolicLink(), false);
assert.equal(stat.uid, process.getuid());
assert.equal(stat.nlink, 1);
assert.equal(stat.mode & 0o777, input.mode);
const argv = [
  "--mode", "install",
  "--bundle", input.bundleDirectory,
  "--manifest-sha256", input.manifestSha256,
  "--preflight-evidence", path.join(path.dirname(input.bundleDirectory), "evidence.json"),
  "--preflight-sha256", "b".repeat(64),
  "--attempt-id", input.attemptId,
];
let invocations = 0;
let invocation;
const options = {
  argv,
  environment: "rehearsal",
  expectedUid: process.getuid(),
  runLocked: (actualRuntime, installerPath, forwardedArgs, policy) => {
    invocations += 1;
    invocation = { actualRuntime, installerPath, forwardedArgs, policy };
  },
};

if (input.outcome === "unsafe-runtime-rejected") {
  assert.notEqual(stat.mode & 0o022, 0);
  assert.throws(() => launchStoppedCandidate(options), /trusted launcher Node runtime custody mismatch/);
  assert.equal(invocations, 0, "unsafe runtime must not reach locked execution");
} else {
  assert.equal(input.outcome, "accepted-and-tamper-rejected");
  assert.equal(stat.mode & 0o022, 0);
  assert.equal(launchStoppedCandidate(options), true);
  assert.equal(invocations, 1);
  assert.equal(invocation.actualRuntime, runtime);
  assert.equal(invocation.forwardedArgs, argv);
  assert.equal(path.dirname(invocation.installerPath), path.join(input.bundleDirectory, "payload"));
  assert.deepEqual(invocation.policy.childEnv, {
    PATH: "/usr/bin:/bin",
    LANG: "C",
    LK1_SUBSCRIPTION_DEV_STOPPED_LOCK_HELD: "HELD_BY_TRUSTED_STOPPED_INSTALL_LAUNCHER",
    LK1_SUBSCRIPTION_DEV_STOPPED_LOCK_FD: "3",
  });
  fs.chmodSync(invocation.installerPath, 0o750);
  fs.appendFileSync(invocation.installerPath, "\n");
  fs.chmodSync(invocation.installerPath, 0o550);
  assert.throws(() => launchStoppedCandidate(options), /payload drift/);
  assert.equal(invocations, 1, "tampered installer must not reach locked execution again");
}

console.log(`LAUNCHER_RUNTIME_FIXTURE=PASS mode=${input.mode.toString(8)} outcome=${input.outcome}`);
