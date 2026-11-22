#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createSubscription409Installer } from "./diagnostics/subscription409-installer.mjs";
import { assertKernelFlock } from "./diagnostics/subscription409-lock.mjs";
import { ROOT, LOCK_NAME, sha, digest, validateContract } from "./diagnostics/subscription409-contract.mjs";
import { createProcessAdapter } from "./diagnostics/subscription409-process.mjs";
import { assertProtectedFile } from "./nodered_reviewed_flow_deploy/runtime_contract.mjs";

// Deliberately no SSH, workflow dispatch, upload or automatic invocation from CI.
export function main(args = process.argv.slice(2)) {
  const [action, packet, approvedSha, ...flags] = args;
  if (!["status", "apply", "resume", "finish", "rollback"].includes(action) || !packet || !digest(approvedSha)) throw Error("USAGE_INVALID");
  if (flags.some(f => !/^--(?:locked|restart-quiesced|recovery-pid=\d+|recovery-count=\d+|recovery-status=(?:online|errored|stopped))$/.test(f))) throw Error("FLAG_INVALID");
  if (process.platform !== "linux" || process.getuid() !== 0) throw Error("ROOT_LINUX_147_REQUIRED");
  const contractFile = path.resolve(packet, "contract.json"); assertProtectedFile(contractFile);
  const bytes = fs.readFileSync(contractFile);
  if (sha(bytes) !== approvedSha) throw Error("APPROVAL_DIGEST_MISMATCH");
  const c = validateContract(JSON.parse(bytes));
  const script = import.meta.url ? fileURLToPath(import.meta.url) : process.argv[1];
  if (sha(fs.readFileSync(script)) !== c.installerSha256) throw Error("INSTALLER_DIGEST_MISMATCH");
  if (!Buffer.from(JSON.stringify(c)).equals(bytes)) throw Error("CONTRACT_NOT_CANONICAL");
  const machineSha256 = sha(fs.readFileSync("/etc/machine-id"));
  if (c.machineSha256 !== machineSha256) throw Error("MACHINE_DRIFT");
  const lock = path.join(ROOT, LOCK_NAME);
  if (action !== "status") {
    if (process.env.PADLHUB_SUBSCRIPTION409_INSTALL !== "CONFIRM_147") throw Error("EXPLICIT_147_AUTHORITY_REQUIRED");
    if (!flags.includes("--locked")) {
      // Open only after exact-target authority and contract verification.
      if (fs.existsSync(lock)) assertProtectedFile(lock);
      else {
        const fd = fs.openSync(lock, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
        fs.closeSync(fd);
      }
      assertProtectedFile(lock);
      const result = spawnSync("flock", ["-n", "-F", lock, process.execPath, script, ...args, "--locked"], { stdio: "inherit" });
      if (result.error || result.status !== 0) throw Error("GUARDED_OPERATION_FAILED");
      return;
    }
    assertKernelFlock(lock);
  }
  const runtime = createSubscription409Installer({ machineSha256, pm2: createProcessAdapter(), assertLock: () => assertKernelFlock(lock) });
  let result;
  if (action === "apply") {
    const load = name => { const file = path.resolve(packet, name); assertProtectedFile(file); return fs.readFileSync(file); };
    result = runtime.apply(c, { bundle: load("observer.cjs"), beforeSettings: load("settings.before.js"), afterSettings: load("settings.after.js") });
  } else if (["rollback", "resume"].includes(action)) {
    const pid = flags.find(v => v.startsWith("--recovery-pid=")), count = flags.find(v => v.startsWith("--recovery-count="));
    const status = flags.find(v => v.startsWith("--recovery-status="))?.split("=")[1] || "online";
    result = runtime[action](c, { restartQuiesced: flags.includes("--restart-quiesced"),
      recoveryProcess: pid && count ? { pid: Number(pid.split("=")[1]), restartCount: Number(count.split("=")[1]), status } : undefined });
  } else result = runtime[action](c);
  // Contract/source/lease tokens, settings and raw PM2 output never go to stdout.
  console.log(JSON.stringify({ state: result.state, activationPerformed: action === "apply" && result.state === "SOAKING" }));
}
if (import.meta.url && process.argv[1] === fileURLToPath(import.meta.url)) {
  try { main(); } catch (e) {
    console.error(JSON.stringify({ code: /^[A-Z0-9_]+$/.test(e.message) ? e.message : "INSTALLER_FAILED" })); process.exitCode = 1;
  }
}
