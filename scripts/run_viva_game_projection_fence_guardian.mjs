#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { canonicalJson, sha256 } from "./lib/vivaGameProjectionCutoverContract.mjs";

const RELEASE_CONFIRMATION = "RELEASE_VIVA_GAME_PROJECTION_CUTOVER_FENCE_V1";
const fail = (message) => { throw new Error(message); };
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!key?.startsWith("--") || !value || value.startsWith("--") || args.has(key)) fail("Invalid guardian argument");
  args.set(key, value);
}

if (process.getuid?.() !== 0) fail("Fence guardian requires root");
const fd = Number(process.env.PADLHUB_CUTOVER_FENCE_FD);
const lockPath = String(process.env.PADLHUB_CUTOVER_FENCE_LOCK_PATH || "");
const token = String(process.env.PADLHUB_CUTOVER_FENCE_TOKEN || "");
const receiptPath = path.resolve(args.get("--receipt") || "");
const releasePath = path.resolve(args.get("--release-request") || "");
const receiptParent = path.dirname(receiptPath);
const parentStat = fs.lstatSync(receiptParent);
if (!Number.isSafeInteger(fd) || fd < 3 || lockPath !== "/run/lock/padlhub-viva-game-projection-cutover.lock"
  || token.length < 32 || !path.isAbsolute(receiptPath) || !path.isAbsolute(releasePath)
  || path.dirname(releasePath) !== receiptParent || !parentStat.isDirectory() || parentStat.isSymbolicLink()
  || fs.realpathSync(receiptParent) !== receiptParent || parentStat.uid !== process.getuid() || (parentStat.mode & 0o077) !== 0
  || fs.existsSync(receiptPath) || receiptPath === releasePath) fail("Fence guardian inputs are invalid");
const stat = fs.fstatSync(fd);
const lockStat = fs.statSync(lockPath);
if (!stat.isFile() || stat.dev !== lockStat.dev || stat.ino !== lockStat.ino) fail("Fence guardian did not inherit the canonical lock descriptor");
const probe = spawnSync("flock", ["-n", lockPath, "-c", "true"], { stdio: "ignore" });
if (probe.error || probe.status === 0) fail("Fence guardian did not inherit an exclusive lock");

const tokenSha256 = sha256(token);
const receipt = {
  formatVersion: 1,
  kind: "viva-game-projection-fence-guardian-receipt",
  state: "HOLDING_UNTIL_EXPLICIT_RELEASE",
  pid: process.pid,
  lockPath,
  fenceTokenSha256: tokenSha256,
  startedAt: new Date().toISOString(),
  automaticRelease: false,
};
const descriptor = fs.openSync(receiptPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
try {
  fs.writeFileSync(descriptor, canonicalJson(receipt));
  fs.fsyncSync(descriptor);
} finally { fs.closeSync(descriptor); }
const parentDescriptor = fs.openSync(receiptParent, fs.constants.O_RDONLY);
try { fs.fsyncSync(parentDescriptor); } finally { fs.closeSync(parentDescriptor); }

process.on("SIGHUP", () => {});
process.on("SIGINT", () => {});
process.on("SIGTERM", () => {});

while (true) {
  fs.fstatSync(fd);
  if (fs.existsSync(releasePath)) {
    const releaseStat = fs.lstatSync(releasePath);
    if (!releaseStat.isFile() || releaseStat.isSymbolicLink() || releaseStat.nlink !== 1
      || releaseStat.uid !== process.getuid() || (releaseStat.mode & 0o077) !== 0) fail("Fence release request is not private");
    let release;
    try { release = JSON.parse(fs.readFileSync(releasePath, "utf8")); } catch { fail("Fence release request is invalid"); }
    const authorizedAt = Date.parse(release?.authorizedAt);
    const nowMs = Date.now();
    if (release?.formatVersion !== 1 || release?.kind !== "viva-game-projection-fence-release-request"
      || release?.state !== "RELEASE_AUTHORIZED" || release?.confirmation !== RELEASE_CONFIRMATION
      || release?.fenceTokenSha256 !== tokenSha256 || !Number.isFinite(authorizedAt)
      || authorizedAt > nowMs + 60_000 || nowMs - authorizedAt > 5 * 60_000) {
      fail("Fence release request does not authorize this exact guardian");
    }
    process.exit(0);
  }
  await sleep(1000);
}
