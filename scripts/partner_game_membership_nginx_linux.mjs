// Read-only Linux observation for the isolated controlled-application rehearsal.
// No arbitrary proc root, commands, signals, production fallback or secret output.
import fs from "node:fs";
import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

const fail = code => { throw new Error(code); };
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const integer = value => /^(?:[1-9][0-9]{0,9})$/.test(String(value)) && Number.isSafeInteger(Number(value));
export function parseNginxProcStat(text, expectedPid) {
  if (typeof text !== "string" || text.length > 8192 || !integer(expectedPid)) fail("NGINX_PROC_STAT_INVALID");
  const match = /^(\d+) \(nginx\) ([RSDI]) (.+)\n?$/.exec(text.trimEnd());
  const fields = match?.[3].split(" ");
  if (!match || Number(match[1]) !== expectedPid || fields.length < 19
    || !/^\d+$/.test(fields[0]) || !integer(fields[18])) fail("NGINX_PROC_STAT_INVALID");
  return { pid: expectedPid, parentPid: Number(fields[0]), startTicks: fields[18] };
}
function bounded(file, maximum) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  try {
    const buffer = Buffer.alloc(maximum + 1); let offset = 0;
    while (offset < buffer.length) { const n = fs.readSync(fd, buffer, offset, buffer.length - offset, null); if (!n) break; offset += n; }
    if (!offset || offset > maximum) fail("NGINX_OBSERVATION_SIZE");
    return buffer.subarray(0, offset);
  } finally { fs.closeSync(fd); }
}
function identity(pid, role) {
  const stat = () => parseNginxProcStat(bounded(`/proc/${pid}/stat`, 8192).toString(), pid);
  const before = stat(), raw = bounded(`/proc/${pid}/cmdline`, 4096).toString();
  const title = raw.replace(/\0+$/, "");
  if (role === "master" ? title !== "nginx: master process /usr/sbin/nginx -c /control/nginx.conf -g daemon off;"
    : !/^nginx: worker process(?: is shutting down)?$/.test(title)) fail("NGINX_PROCESS_COMMAND_MISMATCH");
  const executableSha256 = sha(bounded(`/proc/${pid}/exe`, 16 * 1024 * 1024));
  const after = stat();
  if (!isDeepStrictEqual(before, after)) fail("NGINX_PROCESS_CHANGED_DURING_READ");
  return { ...after, executableSha256, draining: title.endsWith("is shutting down") };
}
function configuration() {
  const file = "/control/nginx.conf", before = fs.lstatSync(file, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n || before.uid !== BigInt(process.getuid())
    || (before.mode & 0o777n) !== 0o600n || fs.realpathSync(file) !== file) fail("NGINX_CONFIG_CUSTODY_FAILED");
  const bytes = bounded(file, 65536), after = fs.lstatSync(file, { bigint: true });
  const id = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode, stat.uid, stat.nlink];
  if (!isDeepStrictEqual(id(before), id(after)) || after.size !== BigInt(bytes.length)) fail("NGINX_CONFIG_CHANGED_DURING_READ");
  return sha(bytes);
}
export function collectLocalNginxLinuxSnapshot() {
  if (process.platform !== "linux" || process.arch !== "x64" || process.getuid() === 0) fail("LOCAL_NGINX_LINUX_FIXTURE_REQUIRED");
  const rawPid = bounded("/control/nginx.pid", 32).toString().trim();
  if (!integer(rawPid)) fail("NGINX_PID_INVALID");
  const pid = Number(rawPid), before = configuration(), master = identity(pid, "master");
  const childrenText = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim();
  const children = childrenText ? childrenText.split(/\s+/) : [];
  if (!children.length || children.length > 8 || children.some(child => !integer(child))
    || new Set(children).size !== children.length) fail("NGINX_WORKER_SET_INVALID");
  const workers = children.map(child => identity(Number(child), "worker")).sort((a, b) => a.pid - b.pid);
  if (workers.some(worker => worker.parentPid !== pid || worker.executableSha256 !== master.executableSha256)
    || !isDeepStrictEqual(identity(pid, "master"), master)
    || fs.readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim() !== childrenText
    || configuration() !== before) fail("NGINX_SNAPSHOT_DRIFT");
  const namespace = name => {
    const own = fs.readlinkSync(`/proc/self/ns/${name}`), target = fs.readlinkSync(`/proc/${pid}/ns/${name}`);
    if (own !== target) fail("NGINX_NAMESPACE_MISMATCH");
    return sha(target);
  };
  return { scope: "LOCAL_FIXTURE", configSha256: before, master, workers,
    bootSha256: sha(bounded("/proc/sys/kernel/random/boot_id", 64)),
    pidNamespaceSha256: namespace("pid"), networkNamespaceSha256: namespace("net") };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3 || process.argv[2] !== "snapshot") fail("NGINX_READER_ARGUMENTS_INVALID");
    process.stdout.write(JSON.stringify(collectLocalNginxLinuxSnapshot()) + "\n");
  } catch (error) { process.stderr.write(/^NGINX_|^LOCAL_NGINX_/.test(error.message) ? error.message + "\n" : "NGINX_OBSERVATION_FAILED\n"); process.exitCode = 1; }
}
