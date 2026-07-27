import { execFileSync } from "node:child_process";

const FULL_GIT_SHA = /^[0-9a-f]{40}$/;

function runGit(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function readCurrentBranch(cwd) {
  try {
    return runGit(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  } catch {
    return "DETACHED";
  }
}

export function readRepositoryProvenance(cwd) {
  const sourceCommit = runGit(cwd, ["rev-parse", "HEAD"]);
  const sourceBranch = readCurrentBranch(cwd);
  const rawStatus = execFileSync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all", "-z"],
    {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const changes = rawStatus.split("\0").filter(Boolean);

  return {
    sourceCommit,
    sourceBranch,
    sourceDirty: changes.length > 0,
    changes,
  };
}

export function validateReleaseManifestProvenance(payload, repository) {
  const errors = [];

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return ["release manifest must contain a JSON object"];
  }

  if (!FULL_GIT_SHA.test(String(payload.sourceCommit || ""))) {
    errors.push("release manifest sourceCommit must be a full 40-character Git SHA");
  } else if (payload.sourceCommit !== repository.sourceCommit) {
    errors.push(
      `release manifest was built from ${payload.sourceCommit}, current HEAD is ${repository.sourceCommit}`,
    );
  }

  if (payload.sourceDirty !== false) {
    errors.push("release manifest was produced from a dirty or unknown source tree");
  }

  return errors;
}
