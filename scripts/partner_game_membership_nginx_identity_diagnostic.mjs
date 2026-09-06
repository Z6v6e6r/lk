// Diagnostic only: never accepts a process identity or opens production ingress.
import fs from "node:fs";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { parseNginxProcStat, collectLocalNginxLinuxSnapshot } from "./partner_game_membership_nginx_linux.mjs";

const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const fail = () => { throw new Error("NGINX_IDENTITY_DIAGNOSTIC_FAILED"); };
const titles = {
  MASTER_TITLE: Buffer.from("nginx: master process /usr/sbin/nginx -c /control/nginx.conf -g daemon off;"),
  WORKER_TITLE: Buffer.from("nginx: worker process"),
  DRAINING_WORKER_TITLE: Buffer.from("nginx: worker process is shutting down"),
  ORIGINAL_NGINX_ARGV: Buffer.from("/usr/sbin/nginx\0-c\0/control/nginx.conf\0-g\0daemon off;"),
};

export function parseNginxRehearsalMode(args) {
  if (!Array.isArray(args) || args.length !== 1) fail();
  if (args[0] === "--owned-local-application") return "application";
  if (args[0] === "--owned-local-identity-diagnostic") return "diagnostic";
  fail();
}
export async function runNginxRehearsalMode(mode, actions) {
  if (mode === "diagnostic") return await actions.diagnostic();
  if (mode === "application") return await actions.application();
  fail();
}

export function summarizeNginxDiagnosticCommand(raw) {
  if (!Buffer.isBuffer(raw) || !raw.length || raw.length > 4096) fail();
  let end = raw.length;
  while (end && raw[end - 1] === 0) end--;
  const withoutNuls = raw.subarray(0, end), trailingNuls = raw.length - end;
  let spaceEnd = end;
  while (spaceEnd && raw[spaceEnd - 1] === 0x20) spaceEnd--;
  const trailingAsciiSpaces = end - spaceEnd;
  const exactShape = Object.entries(titles).find(([, value]) => withoutNuls.equals(value))?.[0];
  const paddedShape = Object.entries(titles).find(([name, value]) => name !== "ORIGINAL_NGINX_ARGV" && trailingAsciiSpaces > 0
    && raw.subarray(0, spaceEnd).equals(value))?.[0];
  return { rawSha256: sha(raw), byteLength: raw.length, nulCount: raw.filter(byte => byte === 0).length,
    trailingNuls, trailingAsciiSpaces,
    shape: exactShape ?? (paddedShape ? `${paddedShape}_ASCII_SPACE_PADDING` : "UNKNOWN_REDACTED"),
    strictMasterMatches: withoutNuls.equals(titles.MASTER_TITLE),
    strictWorkerMatches: withoutNuls.equals(titles.WORKER_TITLE) || withoutNuls.equals(titles.DRAINING_WORKER_TITLE) };
}
function bounded(file, maximum) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  try {
    const buffer = Buffer.alloc(maximum + 1); let offset = 0;
    while (offset < buffer.length) { const n = fs.readSync(fd, buffer, offset, buffer.length - offset, null); if (!n) break; offset += n; }
    if (!offset || offset > maximum) fail();
    return buffer.subarray(0, offset);
  } finally { fs.closeSync(fd); }
}
function capture(progress) {
  progress.stage = "PLATFORM";
  if (process.platform !== "linux" || process.arch !== "x64" || process.getuid() === 0) fail();
  progress.stage = "PIDFILE";
  const pidText = bounded("/control/nginx.pid", 32).toString().trim();
  if (!/^[1-9][0-9]{0,9}$/.test(pidText)) fail();
  const masterPid = Number(pidText);
  progress.stage = "CHILDREN";
  const children = () => bounded(`/proc/${masterPid}/task/${masterPid}/children`, 128).toString().trim().split(/\s+/);
  const childIds = children();
  if (!childIds.length || childIds.length > 8 || new Set(childIds).size !== childIds.length || childIds.some(pid => !/^[1-9][0-9]{0,9}$/.test(pid))) fail();
  const processes = [masterPid, ...childIds.map(Number)].map((pid, index) => {
    progress.role = index ? "worker" : "master"; progress.stage = "STAT"; progress.commandShape = null;
    const stat = () => parseNginxProcStat(bounded(`/proc/${pid}/stat`, 8192).toString(), pid);
    const before = stat(); progress.stage = "COMMAND";
    const command = summarizeNginxDiagnosticCommand(bounded(`/proc/${pid}/cmdline`, 4096));
    progress.commandShape = command.shape; progress.stage = "EXECUTABLE";
    const executableSha256 = sha(bounded(`/proc/${pid}/exe`, 16 * 1024 * 1024));
    progress.stage = "EXECUTABLE_LINK";
    const executableLink = fs.readlinkSync(`/proc/${pid}/exe`);
    progress.stage = "NAMESPACE";
    const namespaces = Object.fromEntries(["pid", "net"].map(name => {
      const own = fs.readlinkSync(`/proc/self/ns/${name}`), actual = fs.readlinkSync(`/proc/${pid}/ns/${name}`);
      if (own !== actual) fail();
      return [name, sha(actual)];
    }));
    progress.stage = "STABLE_STAT"; assert.deepEqual(stat(), before);
    if (index && before.parentPid !== masterPid) fail();
    return { role: index ? "worker" : "master", ...before, command, executableSha256,
      executablePathShape: executableLink === "/usr/sbin/nginx" ? "EXPECTED_NGINX_PATH" : "OTHER_REDACTED",
      executablePathSha256: sha(executableLink), namespaces };
  });
  progress.role = null; progress.commandShape = null; progress.stage = "STABLE_CHILDREN";
  assert.deepEqual(children(), childIds);
  assert.equal(bounded("/control/nginx.pid", 32).toString().trim(), pidText);
  progress.stage = "CONFIG"; const configSha256 = sha(bounded("/control/nginx.conf", 65536));
  progress.stage = "BOOT"; const bootSha256 = sha(bounded("/proc/sys/kernel/random/boot_id", 64));
  return { processes, configSha256, bootSha256 };
}
export function classifyNginxIdentityDiagnostic(before, after, strict) {
  assert.deepEqual(after, before);
  if (!(strict?.state === "ACCEPTED" && strict.code === null)
    && !(strict?.state === "REJECTED" && ["NGINX_PROCESS_COMMAND_MISMATCH", "OTHER_STRICT_REJECTION_REDACTED"].includes(strict.code))) fail();
  const [master, ...workers] = before.processes;
  if (!master || master.role !== "master" || !workers.length || workers.length > 8) fail();
  for (const worker of workers) {
    if (worker.role !== "worker" || worker.pid === master.pid || worker.parentPid !== master.pid
      || worker.executableSha256 !== master.executableSha256 || worker.executablePathSha256 !== master.executablePathSha256
      || BigInt(worker.startTicks) < BigInt(master.startTicks)) fail();
    assert.deepEqual(worker.namespaces, master.namespaces);
  }
  let classification = "CAUSE_UNRESOLVED", rejectedRole = null;
  if (strict.state === "ACCEPTED") classification = "NOT_REPRODUCED";
  else if (strict.code === "NGINX_PROCESS_COMMAND_MISMATCH") {
    const rejected = !master.command.strictMasterMatches ? master : workers.find(worker => !worker.command.strictWorkerMatches);
    if (rejected && rejected.command.shape !== "UNKNOWN_REDACTED") {
      classification = "KNOWN_COMMAND_FORM_REJECTED"; rejectedRole = rejected.role;
    }
  }
  return { state: "DIAGNOSTIC_CAPTURE_ONLY_NOT_APPLICATION_PROOF", classification, rejectedRole,
    before, after, strict, applicationProbes: "NOT_RUN", hup: "NOT_RUN",
    productionVerified: false, deployAuthorized: false, activationAuthorized: false };
}
const stages = new Set(["PLATFORM", "PIDFILE", "CHILDREN", "STAT", "COMMAND", "EXECUTABLE", "EXECUTABLE_LINK", "NAMESPACE", "STABLE_STAT", "STABLE_CHILDREN", "CONFIG", "BOOT", "CONSISTENCY"]);
const shapes = new Set([...Object.keys(titles), ...Object.keys(titles).filter(key => key !== "ORIGINAL_NGINX_ARGV").map(key => `${key}_ASCII_SPACE_PADDING`), "UNKNOWN_REDACTED"]);
function redactFailure(error, progress) {
  return { pass: progress.pass === "AFTER" ? "AFTER" : "BEFORE",
    stage: stages.has(progress.stage) ? progress.stage : "OTHER_REDACTED",
    role: ["master", "worker"].includes(progress.role) ? progress.role : null,
    code: ["EACCES", "EPERM", "ENOENT", "ESRCH", "ERR_ASSERTION"].includes(error?.code) ? error.code : "OTHER_REDACTED",
    observedCommandShape: shapes.has(progress.commandShape) ? progress.commandShape : null };
}
// Fixture-only test seam. Production entry does not import this module or accept
// these callbacks. Partial capture is never returned as an accepted identity.
export function runNginxIdentityDiagnosticCapture(captureSnapshot, readStrict) {
  const progress = { pass: "BEFORE", stage: "PLATFORM", role: null, commandShape: null };
  let before, after, failure, strict;
  try { before = captureSnapshot(progress); } catch (error) { failure = redactFailure(error, progress); }
  // Preserve the original strict outcome even when an additional diagnostic read
  // (which the strict mismatch would never reach) was unavailable.
  try { readStrict(); strict = { state: "ACCEPTED", code: null }; }
  catch (error) { strict = { state: "REJECTED", code: error.message === "NGINX_PROCESS_COMMAND_MISMATCH" ? error.message : "OTHER_STRICT_REJECTION_REDACTED" }; }
  if (!failure) {
    progress.pass = "AFTER"; progress.stage = "PLATFORM"; progress.role = null; progress.commandShape = null;
    try { after = captureSnapshot(progress); progress.stage = "CONSISTENCY"; return classifyNginxIdentityDiagnostic(before, after, strict); }
    catch (error) { failure = redactFailure(error, progress); }
  }
  return { state: "DIAGNOSTIC_INCOMPLETE", classification: "CAUSE_UNRESOLVED", failure, strict,
    applicationProbes: "NOT_RUN", hup: "NOT_RUN", productionVerified: false, deployAuthorized: false, activationAuthorized: false };
}
export function collectNginxIdentityDiagnostic() {
  return runNginxIdentityDiagnosticCapture(capture, collectLocalNginxLinuxSnapshot);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3 || process.argv[2] !== "capture") fail();
    const result = collectNginxIdentityDiagnostic(); process.stdout.write(JSON.stringify(result) + "\n");
    if (result.state === "DIAGNOSTIC_INCOMPLETE") process.exitCode = 1;
  } catch { process.stderr.write("NGINX_IDENTITY_DIAGNOSTIC_FAILED\n"); process.exitCode = 1; }
}
