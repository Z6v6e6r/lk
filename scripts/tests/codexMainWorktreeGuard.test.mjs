import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const guardPath = fileURLToPath(new URL("../codex_main_worktree_guard.mjs", import.meta.url));

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function runGuard(cwd, args) {
  return execFileSync(process.execPath, [guardPath, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function claimArguments(cwd, owner) {
  return ["claim", "--owner", owner,
    "--expected-main-sha", git(cwd, ["rev-parse", "origin/main"]),
    "--expected-main-tree", git(cwd, ["rev-parse", "origin/main^{tree}"])];
}

function releaseArguments(owner, lease) {
  return ["release", "--owner", owner, "--lease-id", lease.leaseId];
}

function runGuardResult(cwd, args) {
  try {
    return { status: 0, stdout: runGuard(cwd, args), stderr: "" };
  } catch (error) {
    return { status: error.status, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

function runGuardAsync(cwd, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [guardPath, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "codex-main-guard-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = join(root, "remote.git");
  const primary = join(root, "primary");
  const mainWorktree = join(root, "main-owner");
  const taskWorktree = join(root, "task");
  git(root, ["init", "--bare", "--quiet", remote]);
  git(root, ["clone", "--quiet", remote, primary]);
  git(primary, ["config", "user.name", "Guard Test"]);
  git(primary, ["config", "user.email", "ci"]);
  await writeFile(join(primary, "README.md"), "fixture\n", "utf8");
  git(primary, ["add", "README.md"]);
  git(primary, ["commit", "--quiet", "-m", "fixture"]);
  git(primary, ["branch", "-M", "main"]);
  git(primary, ["push", "--quiet", "-u", "origin", "main"]);
  git(primary, ["switch", "--quiet", "-c", "holder"]);
  git(primary, ["worktree", "add", "--quiet", mainWorktree, "main"]);
  git(primary, ["worktree", "add", "--quiet", "-b", "codex/guard-test", taskWorktree, "main"]);
  const commonDirectory = git(mainWorktree, ["rev-parse", "--git-common-dir"]);
  return { root, primary, mainWorktree, taskWorktree, leasePath: join(commonDirectory, "codex-main-owner-v1.json") };
}

test("task checks reject the primary checkout and accept a clean isolated codex worktree", async (t) => {
  const f = await fixture(t);
  const primary = runGuardResult(f.primary, ["check-task"]);
  assert.equal(primary.status, 1);
  assert.match(primary.stderr, /Primary\/shared checkout is forbidden/);
  assert.equal(runGuard(f.taskWorktree, ["check-task"]), "TASK_WORKTREE_OK");
});

test("main requires an exact matching lease", async (t) => {
  const f = await fixture(t);
  const unclaimed = runGuardResult(f.mainWorktree, ["check-task", "--owner", "thread-a"]);
  assert.equal(unclaimed.status, 1);
  assert.match(unclaimed.stderr, /No merge-owner lease is claimed/);
  runGuard(f.mainWorktree, claimArguments(f.mainWorktree, "thread-a"));
  assert.equal(runGuard(f.mainWorktree, ["check-task", "--owner", "thread-a"]), "MERGE_OWNER_WORKTREE_OK");
});

test("parallel claims publish exactly one lease without clobbering", async (t) => {
  const f = await fixture(t);
  const results = await Promise.all([
    runGuardAsync(f.mainWorktree, claimArguments(f.mainWorktree, "thread-a")),
    runGuardAsync(f.mainWorktree, claimArguments(f.mainWorktree, "thread-b")),
  ]);
  assert.deepEqual(results.map(({ status }) => status).sort(), [0, 1]);
  assert.match(results.find(({ status }) => status === 1).stderr, /already claimed by|mutation lock exists/);
  const lease = JSON.parse(await readFile(f.leasePath, "utf8"));
  assert.ok(["thread-a", "thread-b"].includes(lease.ownerId));
});

test("verify rejects wrong owner, worktree, Git drift, and dirty state", async (t) => {
  const f = await fixture(t);
  runGuard(f.mainWorktree, claimArguments(f.mainWorktree, "thread-a"));
  assert.equal(runGuardResult(f.mainWorktree, ["verify", "--owner", "thread-b"]).status, 1);
  assert.equal(runGuardResult(f.taskWorktree, ["verify", "--owner", "thread-a"]).status, 1);
  await writeFile(join(f.mainWorktree, "drift.txt"), "dirty\n", "utf8");
  const dirty = runGuardResult(f.mainWorktree, ["verify", "--owner", "thread-a"]);
  assert.equal(dirty.status, 1);
  assert.match(dirty.stderr, /Worktree must be clean/);
  git(f.mainWorktree, ["add", "drift.txt"]);
  git(f.mainWorktree, ["commit", "--quiet", "-m", "drift"]);
  const drifted = runGuardResult(f.mainWorktree, ["verify", "--owner", "thread-a"]);
  assert.equal(drifted.status, 1);
  assert.match(drifted.stderr, /HEAD SHA drifted/);
});

test("only the matching owner in the claiming worktree may release", async (t) => {
  const f = await fixture(t);
  const lease = JSON.parse(runGuard(f.mainWorktree, claimArguments(f.mainWorktree, "thread-a")));
  assert.equal(runGuardResult(f.mainWorktree, releaseArguments("thread-b", lease)).status, 1);
  assert.equal(runGuardResult(f.taskWorktree, releaseArguments("thread-a", lease)).status, 1);
  assert.equal(runGuard(f.mainWorktree, releaseArguments("thread-a", lease)), "MERGE_OWNER_LEASE_RELEASED");
  assert.equal(runGuard(f.mainWorktree, ["status"]), "UNCLAIMED");
});

test("corrupt or symlink leases fail closed", async (t) => {
  const corrupt = await fixture(t);
  await writeFile(corrupt.leasePath, "not json\n", "utf8");
  assert.match(runGuardResult(corrupt.mainWorktree, ["status"]).stderr, /lease is malformed/);

  const linked = await fixture(t);
  const target = join(dirname(linked.leasePath), "lease-target.json");
  await writeFile(target, "{}\n", "utf8");
  await symlink(target, linked.leasePath);
  assert.match(runGuardResult(linked.mainWorktree, ["status"]).stderr, /regular non-symlink file/);
});

test("old leases are never expired or stolen automatically", async (t) => {
  const f = await fixture(t);
  const claimed = JSON.parse(runGuard(f.mainWorktree, claimArguments(f.mainWorktree, "thread-a")));
  claimed.claimedAt = "2000-01-01T00:00:00.000Z";
  await writeFile(f.leasePath, `${JSON.stringify(claimed, null, 2)}\n`, "utf8");
  const before = await readFile(f.leasePath, "utf8");
  const blocked = runGuardResult(f.mainWorktree, claimArguments(f.mainWorktree, "thread-b"));
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /already claimed by thread-a/);
  assert.equal(await readFile(f.leasePath, "utf8"), before);
});

test("claim requires explicit expected SHA and tree and rejects stale authorization", async (t) => {
  const f = await fixture(t);
  assert.match(runGuardResult(f.mainWorktree, ["claim", "--owner", "thread-a"]).stderr, /expected-main-sha/);
  for (const flag of ["--expected-main-sha", "--expected-main-tree"]) {
    const args = claimArguments(f.mainWorktree, "thread-a");
    args[args.indexOf(flag) + 1] = "a".repeat(40);
    assert.match(runGuardResult(f.mainWorktree, args).stderr, /Explicit expected main SHA\/tree/);
  }
  assert.equal(runGuard(f.mainWorktree, ["status"]), "UNCLAIMED");
});

test("duplicate release cannot delete a newer lease even for the same owner", async (t) => {
  const f = await fixture(t);
  const old = JSON.parse(runGuard(f.mainWorktree, claimArguments(f.mainWorktree, "thread-a")));
  const args = releaseArguments("thread-a", old);
  const results = await Promise.all([runGuardAsync(f.mainWorktree, args), runGuardAsync(f.mainWorktree, args)]);
  assert.deepEqual(results.map(({ status }) => status).sort(), [0, 1]);
  const next = JSON.parse(runGuard(f.mainWorktree, claimArguments(f.mainWorktree, "thread-a")));
  assert.notEqual(next.leaseId, old.leaseId);
  assert.match(runGuardResult(f.mainWorktree, args).stderr, /Lease generation mismatch/);
  assert.equal(JSON.parse(runGuard(f.mainWorktree, ["status"])).leaseId, next.leaseId);
});

test("an interrupted mutation lock blocks claim and release without stealing", async (t) => {
  const f = await fixture(t);
  const old = JSON.parse(runGuard(f.mainWorktree, claimArguments(f.mainWorktree, "thread-a")));
  await mkdir(`${f.leasePath}.mutation-lock`, { mode: 0o700 });
  assert.match(runGuardResult(f.mainWorktree, releaseArguments("thread-a", old)).stderr, /mutation lock exists/);
  assert.match(runGuardResult(f.mainWorktree, claimArguments(f.mainWorktree, "thread-b")).stderr, /mutation lock exists/);
  assert.equal(JSON.parse(runGuard(f.mainWorktree, ["status"])).leaseId, old.leaseId);
});

test("ordinary merge invalidates verification but permits release and fresh reclaim", async (t) => {
  const f = await fixture(t);
  const old = JSON.parse(runGuard(f.mainWorktree, claimArguments(f.mainWorktree, "thread-a")));
  await writeFile(join(f.taskWorktree, "feature.txt"), "local fixture\n");
  git(f.taskWorktree, ["add", "feature.txt"]);
  git(f.taskWorktree, ["commit", "--quiet", "-m", "feature"]);
  git(f.mainWorktree, ["merge", "--no-ff", "--no-edit", "codex/guard-test"]);
  const parents = git(f.mainWorktree, ["show", "-s", "--format=%P", "HEAD"]).split(" ");
  assert.equal(parents.length, 2);
  assert.equal(parents[0], old.headSha);
  assert.match(runGuardResult(f.mainWorktree, ["verify", "--owner", "thread-a"]).stderr, /HEAD SHA drifted/);
  runGuard(f.mainWorktree, releaseArguments("thread-a", old));
  assert.match(runGuardResult(f.mainWorktree, claimArguments(f.mainWorktree, "thread-a")).stderr, /exactly match frozen origin\/main/);
  git(f.mainWorktree, ["push", "--quiet", "origin", "main"]);
  git(f.mainWorktree, ["fetch", "--quiet", "origin"]);
  const next = JSON.parse(runGuard(f.mainWorktree, claimArguments(f.mainWorktree, "thread-a")));
  assert.notEqual(next.headSha, old.headSha);
  assert.equal(runGuard(f.mainWorktree, ["verify", "--owner", "thread-a"]), "MERGE_OWNER_LEASE_OK");
});

test("primary checkout is rejected with a separate Git directory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-separate-git-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const primary = join(root, "primary");
  git(root, ["init", "--quiet", "--separate-git-dir", join(root, "metadata"), primary]);
  git(primary, ["-c", "user.name=ci", "-c", "user.email=ci", "commit", "--quiet", "--allow-empty", "-m", "fixture"]);
  git(primary, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  assert.match(runGuardResult(primary, ["check-task"]).stderr, /Primary\/shared checkout is forbidden/);
});
