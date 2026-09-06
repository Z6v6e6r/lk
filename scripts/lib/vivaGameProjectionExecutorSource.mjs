import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { canonicalJson, sha256 } from "./vivaGameProjectionCutoverContract.mjs";

const REPO_ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."));
const HASH_RE = /^[a-f0-9]{64}$/;
const fail = (message) => { throw new Error(message); };

export function assertExactExecutorSources(plan) {
  if (!Array.isArray(plan?.executorSources) || plan.executorSources.length < 8
    || sha256(canonicalJson(plan.executorSources)) !== plan.executorSourcesSha256) {
    fail("Cutover plan lacks an exact executor source manifest");
  }
  const attestedSnapshotRoot = String(process.env.PADLHUB_ATTESTED_EXECUTOR_SNAPSHOT_ROOT || "");
  const attestedCommit = String(process.env.PADLHUB_ATTESTED_EXECUTOR_COMMIT || "");
  if (attestedSnapshotRoot || attestedCommit) {
    if (!path.isAbsolute(attestedSnapshotRoot) || fs.realpathSync(attestedSnapshotRoot) !== attestedSnapshotRoot
      || REPO_ROOT !== attestedSnapshotRoot || attestedCommit !== plan.repository?.commit) {
      fail("Attested executor snapshot identity differs from the cutover plan");
    }
    const rootStat = fs.lstatSync(attestedSnapshotRoot);
    const uid = typeof process.getuid === "function" ? process.getuid() : rootStat.uid;
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== uid || (rootStat.mode & 0o222) !== 0) {
      fail("Attested executor snapshot root is not owned and read-only");
    }
    for (const entry of plan.executorSources) {
      if (!String(entry?.path || "").startsWith("scripts/") || !HASH_RE.test(String(entry?.sha256 || ""))) {
        fail("Cutover executor source entry is invalid");
      }
      const requested = path.resolve(attestedSnapshotRoot, entry.path);
      const relative = path.relative(attestedSnapshotRoot, requested);
      const descriptor = fs.openSync(requested, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const stat = fs.fstatSync(descriptor);
        if (relative !== entry.path || relative.startsWith("..") || path.isAbsolute(relative)
          || !stat.isFile() || stat.nlink !== 1 || stat.uid !== uid || (stat.mode & 0o222) !== 0
          || sha256(fs.readFileSync(descriptor)) !== entry.sha256) {
          fail(`Attested executor snapshot source readback failed: ${entry.path}`);
        }
      } finally { fs.closeSync(descriptor); }
    }
    return true;
  }
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" });
  const status = spawnSync("git", ["status", "--porcelain"], { cwd: REPO_ROOT, encoding: "utf8" });
  if (head.status !== 0 || status.status !== 0 || head.stdout.trim() !== plan.repository?.commit || status.stdout.trim()) {
    fail("Cutover executor is not running from the exact clean reviewed commit");
  }
  for (const entry of plan.executorSources) {
    if (!String(entry?.path || "").startsWith("scripts/") || !HASH_RE.test(String(entry?.sha256 || ""))) {
      fail("Cutover executor source entry is invalid");
    }
    const requested = path.resolve(REPO_ROOT, entry.path);
    const relative = path.relative(REPO_ROOT, requested);
    if (relative.startsWith("..") || path.isAbsolute(relative) || fs.realpathSync(requested) !== requested
      || sha256(fs.readFileSync(requested)) !== entry.sha256) {
      fail(`Cutover executor source readback failed: ${entry.path}`);
    }
  }
  return true;
}
