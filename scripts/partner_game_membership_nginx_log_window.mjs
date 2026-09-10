// Stable-prefix/suffix observation, NOT proof of append-only history or durability.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import { PartnerIngressEvidenceError } from "./partner_game_membership_ingress_evidence.mjs";

const fail = code => { throw new PartnerIngressEvidenceError(code); };
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const MAX_PREFIX = 1048576, MAX_SUFFIX = 65536, WINDOW_MS = 90000;
const identity = stat => [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.nlink];
const snapshot = stat => [...identity(stat), stat.size, stat.mtimeNs, stat.ctimeNs];

// Private, dedicated log only. No reopen after rotation, no path/owner overrides
// after opening, no skip-invalid-lines mode, no file writes or command execution.
export function openPartnerNginxLogWindow(options) {
  if (!options || Object.getPrototypeOf(options) !== Object.prototype
    || !isDeepStrictEqual(Object.keys(options).sort(), ["absolutePath", "expectedOwnerUid"])) fail("NGINX_LOG_POLICY_INVALID");
  const { absolutePath, expectedOwnerUid } = options;
  if (typeof absolutePath !== "string" || !path.isAbsolute(absolutePath) || path.normalize(absolutePath) !== absolutePath
    || !Number.isSafeInteger(expectedOwnerUid) || expectedOwnerUid < 0) fail("NGINX_LOG_POLICY_INVALID");
  let fd, timer, state = "OPEN", expired = false, captured, captureStat;
  const started = performance.now(), startedAt = Date.now(), ancestors = new Map();
  const close = () => {
    clearTimeout(timer); state = "CLOSED";
    if (fd !== undefined) { const owned = fd; fd = undefined; fs.closeSync(owned); }
  };
  const guard = required => {
    if (performance.now() - started >= WINDOW_MS || Date.now() < startedAt || Date.now() - startedAt >= WINDOW_MS) expired = true;
    if (expired) fail("NGINX_LOG_WINDOW_EXPIRED");
    if (state !== required) fail("NGINX_LOG_WINDOW_CLOSED");
  };
  const safe = action => {
    try { return action(); }
    catch (error) {
      try { close(); } catch { fail("NGINX_LOG_CLOSE_FAILED"); }
      if (error instanceof PartnerIngressEvidenceError) throw error;
      fail("NGINX_LOG_OBSERVATION_FAILED");
    }
  };
  const custody = () => {
    const stat = fs.fstatSync(fd, { bigint: true }), named = fs.lstatSync(absolutePath, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || stat.uid !== BigInt(expectedOwnerUid)
      || (stat.mode & 0o7777n) !== 0o600n || !isDeepStrictEqual(snapshot(stat), snapshot(named))
      || fs.realpathSync(absolutePath) !== absolutePath) fail("NGINX_LOG_CUSTODY_CHANGED");
    for (const [directory, original] of ancestors) {
      if (fs.realpathSync(directory) !== directory || !isDeepStrictEqual(snapshot(fs.lstatSync(directory, { bigint: true })), original)) fail("NGINX_LOG_ANCESTOR_CHANGED");
    }
    return stat;
  };
  const read = size => {
    const bytes = Buffer.alloc(size + 1); let offset = 0;
    while (offset < bytes.length) { const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset); if (!count) break; offset += count; }
    if (offset !== size) fail("NGINX_LOG_CHANGED_DURING_READ");
    return bytes.subarray(0, offset);
  };
  return safe(() => {
    if (fs.realpathSync(absolutePath) !== absolutePath) fail("NGINX_LOG_PATH_UNSAFE");
    let directory = path.dirname(absolutePath);
    for (;;) {
      const stat = fs.lstatSync(directory, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022n) !== 0n
        || ![0n, BigInt(expectedOwnerUid)].includes(stat.uid) || fs.realpathSync(directory) !== directory) fail("NGINX_LOG_ANCESTRY_UNSAFE");
      ancestors.set(directory, snapshot(stat));
      if (path.dirname(directory) === directory) break; directory = path.dirname(directory);
    }
    fd = fs.openSync(absolutePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const initial = custody();
    if (initial.size < 0n || initial.size > BigInt(MAX_PREFIX)) fail("NGINX_LOG_PREFIX_TOO_LARGE");
    const prefix = read(Number(initial.size));
    if (prefix.length && prefix.at(-1) !== 10) fail("NGINX_LOG_PARTIAL_INITIAL_LINE");
    if (!isDeepStrictEqual(snapshot(initial), snapshot(custody()))) fail("NGINX_LOG_CHANGED_DURING_READ");
    const prefixSha256 = hash(prefix);
    guard("OPEN"); timer = setTimeout(() => { expired = true; try { close(); } catch { /* Expired session cannot return evidence. */ } }, WINDOW_MS); timer.unref();
    return Object.freeze({
      capture() { return safe(() => {
        guard("OPEN");
        const before = custody();
        if (!isDeepStrictEqual(identity(initial), identity(before))) fail("NGINX_LOG_CUSTODY_CHANGED");
        if (before.size < initial.size) fail("NGINX_LOG_TRUNCATED");
        if (before.size - initial.size > BigInt(MAX_SUFFIX)) fail("NGINX_LOG_SUFFIX_TOO_LARGE");
        const bytes = read(Number(before.size));
        if (hash(bytes.subarray(0, prefix.length)) !== prefixSha256) fail("NGINX_LOG_PREFIX_CHANGED");
        if (!isDeepStrictEqual(snapshot(before), snapshot(custody()))) fail("NGINX_LOG_CHANGED_DURING_READ");
        guard("OPEN"); captured = Buffer.from(bytes.subarray(prefix.length)); captureStat = snapshot(before); state = "CAPTURED";
        if (captured.length && captured.at(-1) !== 10) fail("NGINX_LOG_PARTIAL_FINAL_LINE");
        return Buffer.from(captured);
      }); },
      finish() { return safe(() => {
        guard("CAPTURED");
        if (!isDeepStrictEqual(captureStat, snapshot(custody()))) fail("NGINX_LOG_CHANGED_AFTER_CAPTURE");
        guard("CAPTURED");
        const receipt = { state: "PREFIX_PRESERVED_SUFFIX_OBSERVED_NOT_APPEND_ONLY_PROOF", prefixBytes: prefix.length,
          prefixSha256, suffixBytes: captured.length, suffixSha256: hash(captured), productionVerified: false };
        close(); return Object.freeze(receipt);
      }); },
      close() { return safe(close); },
    });
  });
}
