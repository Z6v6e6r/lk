import crypto from "node:crypto";
import path from "node:path";
import vm from "node:vm";

export const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
export const ROOT = "/root/.node-red";
export const RELEASES = "/opt/padlhub-game-patch409-diagnostics/releases";
export const LEASE_NAME = ".padlhub-reviewed-flow-deploy.lease.json";
export const LOCK_NAME = ".padlhub-reviewed-flow-deploy.lock";
export const MARKER = "// PADLHUB_GAMEPATCH409_V1";
export const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const processEqual = (a, b) => a?.pid === b?.pid && a?.restartCount === b?.restartCount && a?.status === b?.status;
export const validProcess = p => p?.status === "online" && Number.isSafeInteger(p.pid) && p.pid > 0
  && Number.isSafeInteger(p.restartCount) && p.restartCount >= 0;
export const validRecoveryProcess = p => validProcess(p) || (["errored", "stopped"].includes(p?.status)
  && p.pid === 0 && Number.isSafeInteger(p.restartCount) && p.restartCount >= 0);
export const transactionDirectory = (root, generation) => path.join(root, ".gamepatch409-transactions", generation);

// A suffix preserves the entire existing settings body, including auth/middleware.
// Verify BEFORE require: an untrusted artifact must not execute during startup.
export function settingsCandidate(source, { generation, bundleSha256, release, root = ROOT, releases = RELEASES }) {
  if (!Buffer.isBuffer(source) || source.includes("lkDiagnostics") || source.includes(MARKER) || !/^[a-f0-9]{32}$/.test(generation)
    || !digest(bundleSha256) || !/^[a-f0-9]{40}$/.test(release)) throw Error("SETTINGS_INPUT_INVALID");
  const bundlePath = path.join(releases, bundleSha256, "observer.cjs");
  const receiptPath = path.join(transactionDirectory(root, generation), "ready.json");
  const config = { generation, bundleSha256, release, receiptPath };
  const suffix = `\n${MARKER}\ntry {\n  const fs = require("node:fs"), crypto = require("node:crypto");\n  const file = ${JSON.stringify(bundlePath)};\n  const st = fs.lstatSync(file);\n  if (!st.isFile() || st.isSymbolicLink() || fs.realpathSync(file) !== file || st.nlink !== 1 || st.uid !== process.getuid() || (st.mode & 511) !== 384\n    || crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") !== ${JSON.stringify(bundleSha256)}) throw Error("ARTIFACT_INVALID");\n  require(file).registerSettings(module.exports, ${JSON.stringify(config)});\n} catch {\n  try { console.warn(JSON.stringify({ event: "gamepatch409_startup", code: "OBSERVER_UNAVAILABLE" })); } catch {}\n}\n`;
  const candidate = Buffer.concat([source, Buffer.from(suffix)]);
  new vm.Script(candidate.toString("utf8"));
  return candidate;
}

export function validateContract(c) {
  if (c?.formatVersion !== 1 || c.kind !== "gamepatch409-runtime" || c.target !== "lk-primary-147"
    || !/^[a-f0-9]{32}$/.test(c.generation) || !/^[a-f0-9]{40}$/.test(c.release)
    || ![c.settingsSha256, c.candidateSha256, c.bundleSha256, c.installerSha256, c.flowSha256, c.machineSha256,
      c.hooks?.authorize, c.hooks?.ack].every(digest)
    || !validProcess(c.process) || !Number.isSafeInteger(c.createdAtMs)
    || ![0o600, 0o640, 0o644].includes(c.settingsMode)
    || c.coordinatedRestartApproved !== true || !Array.isArray(c.preservedFiles)
    || c.preservedFiles.some(f => !digest(f.sha256) || !/^\/opt\/[A-Za-z0-9_./-]+$/.test(f.path) || f.path.includes("/../"))) {
    throw Error("CONTRACT_INVALID");
  }
  return c;
}
