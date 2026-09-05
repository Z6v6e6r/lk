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
