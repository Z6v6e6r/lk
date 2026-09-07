import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  buildFrontendBootstrapGuard,
  buildFrontendBootstrapLauncher,
  FRONTEND_BOOTSTRAP_GUARD_IMAGE,
} from "../build_frontend_bootstrap_guard.mjs";

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error || result.status !== 0) {
    throw new Error(JSON.stringify({ status: result.status, signal: result.signal,
      stdout: result.stdout, stderr: result.stderr, error: result.error?.message }));
  }
  return String(result.stdout || "").trim();
};

test("static guard executes a clean exact runtime and exchanges nginx bytes atomically", {
  timeout: 120_000,
}, (t) => {
  const artifact = buildFrontendBootstrapGuard();
  const launcherArtifact = buildFrontendBootstrapLauncher();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lk-frontend-guard-rehearsal-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.chmodSync(root, 0o700);
  fs.writeFileSync(path.join(root, "guard"), artifact.bytes, { mode: 0o500 });
  fs.chmodSync(path.join(root, "guard"), 0o500);
  fs.writeFileSync(path.join(root, "launcher"), launcherArtifact.bytes, { mode: 0o500 });
  fs.chmodSync(path.join(root, "launcher"), 0o500);
  fs.writeFileSync(path.join(root, "harness.mjs"), `
import crypto from "node:crypto";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const guardBytes = fs.readFileSync("/input/guard");
const guardSha = sha(guardBytes);
const launcherBytes = fs.readFileSync("/input/launcher");
const launcherSha = sha(launcherBytes);
const manifestSha = "b".repeat(64);
const attempt = "a".repeat(32);
const bundle = "/root/.padlhub-frontend-bootstrap-" + manifestSha;
fs.mkdirSync(bundle + "/payload", { recursive: true, mode: 0o700 });
fs.copyFileSync("/input/guard", bundle + "/payload/guard");
fs.copyFileSync("/input/launcher", bundle + "/payload/launcher");
fs.chmodSync(bundle, 0o700);
fs.chmodSync(bundle + "/payload", 0o700);
fs.chmodSync(bundle + "/payload/guard", 0o500);
fs.chmodSync(bundle + "/payload/launcher", 0o500);
const runtimeSource = \`import fs from "node:fs";
import { fileURLToPath } from "node:url";
const action = process.argv[2];
const allowed = new Set(["PATH", "LANG", "LK_FRONTEND_BOOTSTRAP_GUARD_SHA256",
  "LK_FRONTEND_BOOTSTRAP_GUARD_FD", "LK_FRONTEND_BOOTSTRAP_APPLY"]);
if (Object.keys(process.env).some(key => !allowed.has(key))) process.exit(20);
if (process.env.LK_FRONTEND_BOOTSTRAP_GUARD_SHA256 !== "\${guardSha}") process.exit(21);
if (process.env.LK_FRONTEND_BOOTSTRAP_GUARD_FD !== "6") process.exit(26);
try {
  if (fs.readlinkSync("/proc/self/fd/20") === "/tmp/lk-frontend-inherited-fd-sentinel") process.exit(27);
} catch (error) { if (error.code !== "ENOENT") throw error; }
if (fs.realpathSync(fileURLToPath(import.meta.url)) !== "\${bundle}/payload/runtime.mjs") process.exit(24);
if (["initialize", "apply"].includes(action)) {
  fs.fstatSync(3); fs.fstatSync(5);
}
if (action === "initialize") fs.mkdirSync("/var/www/html/lk-frontend-releases", { recursive: true });
if (action === "apply") fs.fstatSync(4);
process.stdout.write(JSON.stringify({ action }) + "\\\\n");\`;
fs.writeFileSync(bundle + "/payload/runtime.mjs", runtimeSource, { mode: 0o500 });
fs.chmodSync(bundle + "/payload/runtime.mjs", 0o500);
const runtimeSha = sha(runtimeSource);
fs.mkdirSync("/usr/bin", { recursive: true });
fs.copyFileSync(process.execPath, "/usr/bin/node");
fs.chmodSync("/usr/bin/node", 0o755);
fs.mkdirSync("/var/www/html", { recursive: true });
fs.mkdirSync("/etc/nginx", { recursive: true });
const nodeSha = sha(fs.readFileSync("/usr/bin/node"));
const auditSource = \`const allowed = new Set(["PATH", "LANG", "LC_ALL",
  "LK_FRONTEND_AUDIT_SOURCE_SHA256", "LK_FRONTEND_AUDIT_LAUNCHER_SHA256",
  "LK_FRONTEND_AUDIT_NODE_SHA256"]);
if (Object.keys(process.env).some(name => !allowed.has(name))) process.exit(40);
process.stdout.write(JSON.stringify({ source: process.env.LK_FRONTEND_AUDIT_SOURCE_SHA256,
  launcher: process.env.LK_FRONTEND_AUDIT_LAUNCHER_SHA256,
  node: process.env.LK_FRONTEND_AUDIT_NODE_SHA256 }) + "\\\\n");\`;
fs.writeFileSync(bundle + "/payload/audit.mjs", auditSource, { mode: 0o400 });
fs.chmodSync(bundle + "/payload/audit.mjs", 0o400);
const audit = spawnSync(bundle + "/payload/launcher", ["audit", launcherSha,
  bundle + "/payload/audit.mjs", sha(auditSource)], { encoding: "utf8",
  env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", NODE_OPTIONS: "--no-warnings", POISON: "x" } });
if (audit.status !== 0) throw new Error(audit.stderr || audit.stdout);
const auditResult = JSON.parse(audit.stdout.trim());
if (auditResult.source !== sha(auditSource) || auditResult.launcher !== launcherSha
  || auditResult.node !== nodeSha) process.exit(41);
const badAudit = spawnSync(bundle + "/payload/launcher", ["audit", launcherSha,
  bundle + "/payload/audit.mjs", "0".repeat(64)], { encoding: "utf8" });
if (badAudit.status === 0) process.exit(42);
const sentinel = fs.openSync("/tmp/lk-frontend-inherited-fd-sentinel", "w+");
const cleanStdio = () => {
  const descriptors = Array(21).fill("ignore");
  descriptors[1] = "pipe";
  descriptors[2] = "pipe";
  descriptors[20] = sentinel;
  return descriptors;
};
const invoke = (action, authority, expectedRuntimeSha = runtimeSha) => spawnSync(bundle + "/payload/launcher", ["guard",
  launcherSha, bundle + "/payload/guard", guardSha, "run",
  "--action", action, "--bundle", bundle, "--manifest-sha256", manifestSha,
  "--attempt-id", attempt, "--expected-self-sha256", guardSha,
  "--runtime-sha256", expectedRuntimeSha, "--node-sha256", nodeSha, "--authority", authority,
], { encoding: "utf8", stdio: cleanStdio(),
  env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", POISON: "must-not-propagate" } });
for (const [action, authority] of [["preflight", "-"], ["apply", "CONFIRM_EXACT_BOOTSTRAP"]]) {
  const result = invoke(action, authority);
  if (result.status !== 0) throw new Error(JSON.stringify({ action, status: result.status,
    signal: result.signal, stdout: result.stdout, stderr: result.stderr }));
}
const badSelf = spawnSync(bundle + "/payload/guard", ["run", "--action", "preflight",
  "--bundle", bundle, "--manifest-sha256", manifestSha, "--attempt-id", attempt,
  "--expected-self-sha256", "0".repeat(64), "--runtime-sha256", runtimeSha,
  "--node-sha256", nodeSha, "--authority", "-"], { encoding: "utf8" });
if (badSelf.status === 0) process.exit(22);
const fakeGuard = bundle + "/payload/fake-guard";
fs.writeFileSync(fakeGuard, "#!/bin/sh\\nexit 0\\n", { mode: 0o500 });
fs.chmodSync(fakeGuard, 0o500);
const substituted = spawnSync(bundle + "/payload/launcher", ["guard", launcherSha,
  fakeGuard, guardSha, "run", "--ignored", "value"], { encoding: "utf8" });
if (substituted.status === 0 || !substituted.stderr.includes("EXECUTABLE_DIGEST_MISMATCH")) process.exit(25);
fs.chmodSync("/var/www/html/.lk-frontend-bootstrap.lock", 0o666);
const unsafeLock = invoke("apply", "CONFIRM_EXACT_BOOTSTRAP");
if (unsafeLock.status === 0
  || (fs.statSync("/var/www/html/.lk-frontend-bootstrap.lock").mode & 0o777) !== 0o666) process.exit(23);
fs.mkdirSync("/etc/nginx/sites-enabled", { recursive: true });
const config = "/etc/nginx/sites-enabled/padlhub.su";
const replacement = "/etc/nginx/sites-enabled/.padlhub.su." + attempt + ".tmp";
fs.writeFileSync(config, "source\\n", { mode: 0o644 });
fs.writeFileSync(replacement, "candidate\\n", { mode: 0o644 });
const exchange = spawnSync(bundle + "/payload/launcher", ["guard", launcherSha,
  bundle + "/payload/guard", guardSha, "exchange", "--attempt-id", attempt,
  "--expected-self-sha256", guardSha, "--replacement", replacement,
  "--expected-current-sha256", sha("source\\n"),
  "--expected-replacement-sha256", sha("candidate\\n")], { encoding: "utf8" });
if (exchange.status !== 0) throw new Error(exchange.stderr || exchange.stdout);
if (fs.readFileSync(config, "utf8") !== "candidate\\n" || fs.existsSync(replacement)) process.exit(30);
fs.writeFileSync(replacement, "source\\n", { mode: 0o644 });
const refused = spawnSync(bundle + "/payload/launcher", ["guard", launcherSha,
  bundle + "/payload/guard", guardSha, "exchange", "--attempt-id", attempt,
  "--expected-self-sha256", guardSha, "--replacement", replacement,
  "--expected-current-sha256", sha("unknown\\n"),
  "--expected-replacement-sha256", sha("source\\n")], { encoding: "utf8" });
if (refused.status === 0 || fs.readFileSync(config, "utf8") !== "candidate\\n") process.exit(31);
fs.unlinkSync(replacement);
fs.writeFileSync(config, "source\\n", { mode: 0o644 });
fs.writeFileSync(replacement, "candidate\\n", { mode: 0o644 });
const retainedFdRuntime = \`import fs from "node:fs";
import { spawnSync } from "node:child_process";
const guard = "\${bundle}/payload/guard";
const displaced = guard + ".displaced";
fs.renameSync(guard, displaced);
fs.writeFileSync(guard, "#!/bin/sh\\\\nexit 0\\\\n", { mode: 0o500 });
fs.chmodSync(guard, 0o500);
const result = spawnSync("/proc/self/fd/6", ["exchange", "--attempt-id", "\${attempt}",
  "--expected-self-sha256", "\${guardSha}", "--replacement", "\${replacement}",
  "--expected-current-sha256", "\${sha("source\\n")}",
  "--expected-replacement-sha256", "\${sha("candidate\\n")}"],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe", "ignore", "ignore", "ignore", 6] });
if (result.status !== 0) throw new Error(result.stderr || result.stdout);
\`;
fs.unlinkSync(bundle + "/payload/runtime.mjs");
fs.writeFileSync(bundle + "/payload/runtime.mjs", retainedFdRuntime, { mode: 0o500 });
fs.chmodSync(bundle + "/payload/runtime.mjs", 0o500);
const retainedFdResult = invoke("preflight", "-", sha(retainedFdRuntime));
if (retainedFdResult.status !== 0 || fs.readFileSync(config, "utf8") !== "candidate\\n") {
  throw new Error(JSON.stringify({ retainedStatus: retainedFdResult.status,
    retainedStdout: retainedFdResult.stdout, retainedStderr: retainedFdResult.stderr,
    config: fs.readFileSync(config, "utf8") }));
}
fs.unlinkSync(bundle + "/payload/guard");
fs.renameSync(bundle + "/payload/guard.displaced", bundle + "/payload/guard");
const survivorRuntime = \`import fs from "node:fs";
import { spawn } from "node:child_process";
const child = spawn("/bin/sleep", ["60"], { stdio: "ignore" });
fs.writeFileSync("/tmp/lk-frontend-descendant.pid", String(child.pid));
child.unref();\`;
fs.unlinkSync(bundle + "/payload/runtime.mjs");
fs.writeFileSync(bundle + "/payload/runtime.mjs", survivorRuntime, { mode: 0o500 });
fs.chmodSync(bundle + "/payload/runtime.mjs", 0o500);
const survivorResult = invoke("preflight", "-", sha(survivorRuntime));
if (survivorResult.status === 0 || !survivorResult.stderr.includes("RUNTIME_DESCENDANT_SURVIVED")) process.exit(32);
const survivorPid = Number(fs.readFileSync("/tmp/lk-frontend-descendant.pid", "utf8"));
try { process.kill(survivorPid, 0); process.exit(33); } catch (error) { if (error.code !== "ESRCH") throw error; }
fs.closeSync(sentinel);
process.stdout.write(JSON.stringify({ guardSha, launcherSha, runtimeSha, status: "PASS" }) + "\\n");
`, { mode: 0o400 });
  const output = run("docker", ["run", "--rm", "--network", "none", "--platform", "linux/amd64",
    "--mount", `type=bind,src=${root},dst=/input,readonly`, FRONTEND_BOOTSTRAP_GUARD_IMAGE,
    "node", "/input/harness.mjs"]);
  const result = JSON.parse(output.split("\n").at(-1));
  assert.equal(result.guardSha, artifact.sha256);
  assert.equal(result.launcherSha, launcherArtifact.sha256);
  assert.equal(result.status, "PASS");
});
