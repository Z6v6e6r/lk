#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, realpath, rmdir, unlink } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

const LEASE_VERSION = 1;
const LEASE_FILENAME = "codex-main-owner-v1.json";
const OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,127}$/;

function fail(message) {
  throw new Error(message);
}

function git(args, cwd = process.cwd()) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function parseOwner(argv) {
  const ownerIndex = argv.indexOf("--owner");
  const owner = ownerIndex >= 0 ? argv[ownerIndex + 1] : undefined;
  if (!owner || !OWNER_PATTERN.test(owner)) {
    fail("A non-secret --owner identifier (3-128 safe characters) is required");
  }
  return owner;
}

function requiredArgument(argv, flag, pattern) {
  const index = argv.indexOf(flag);
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value || !pattern.test(value)) fail(`A valid ${flag} is required`);
  return value;
}

async function repositoryContext() {
  const topLevel = await realpath(git(["rev-parse", "--show-toplevel"]));
  const commonRaw = git(["rev-parse", "--git-common-dir"]);
  const commonDirectory = await realpath(isAbsolute(commonRaw) ? commonRaw : resolve(topLevel, commonRaw));
  const gitDirectory = await realpath(git(["rev-parse", "--absolute-git-dir"]));
  let branch;
  try {
    branch = git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  } catch {
    fail("Detached HEAD is not allowed for Codex task or merge-owner worktrees");
  }
  const headSha = git(["rev-parse", "HEAD"]);
  const headTree = git(["rev-parse", "HEAD^{tree}"]);
  const originMainSha = git(["rev-parse", "refs/remotes/origin/main"]);
  const originMainTree = git(["rev-parse", "refs/remotes/origin/main^{tree}"]);
  const dirty = git(["status", "--porcelain=v1", "--untracked-files=all"]).length > 0;
  return {
    topLevel,
    commonDirectory,
    isPrimaryWorktree: gitDirectory === commonDirectory,
    leasePath: resolve(commonDirectory, LEASE_FILENAME),
    branch,
    headSha,
    headTree,
    originMainSha,
    originMainTree,
    dirty,
  };
}

function validateLease(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Merge-owner lease is malformed");
  const requiredStrings = [
    "ownerId",
    "leaseId",
    "worktreePath",
    "branch",
    "headSha",
    "headTree",
    "originMainSha",
    "originMainTree",
    "claimedAt",
  ];
  if (value.version !== LEASE_VERSION || requiredStrings.some((key) => typeof value[key] !== "string" || !value[key])) {
    fail("Merge-owner lease is malformed");
  }
  if (!OWNER_PATTERN.test(value.ownerId)) fail("Merge-owner lease owner is malformed");
  if (!/^[0-9a-f-]{36}$/.test(value.leaseId)) fail("Merge-owner lease ID is malformed");
  if (![value.headSha, value.headTree, value.originMainSha, value.originMainTree].every((item) => /^[0-9a-f]{40}$/.test(item))) {
    fail("Merge-owner lease Git identity is malformed");
  }
  if (!Number.isFinite(Date.parse(value.claimedAt))) fail("Merge-owner lease timestamp is malformed");
  return value;
}

async function readLease(leasePath, { optional = false } = {}) {
  let handle;
  try {
    handle = await open(leasePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size < 1 || stats.size > 8192) fail("Merge-owner lease must be a bounded regular non-symlink file");
    let value;
    try {
      value = JSON.parse(await handle.readFile("utf8"));
    } catch {
      fail("Merge-owner lease is malformed");
    }
    return validateLease(value);
  } catch (error) {
    if (optional && error?.code === "ENOENT") return null;
    if (error?.code === "ENOENT") fail("No merge-owner lease is claimed");
    if (error?.code === "ELOOP") fail("Merge-owner lease must be a regular non-symlink file");
    throw error;
  } finally {
    await handle?.close();
  }
}

async function withMutationLock(context, action) {
  const lockPath = `${context.leasePath}.mutation-lock`;
  try {
    await mkdir(lockPath, { mode: 0o700 });
  } catch (error) {
    if (error?.code === "EEXIST") fail("Merge-owner mutation lock exists; no automatic retry or lock stealing");
    throw error;
  }
  try {
    return await action();
  } finally {
    await rmdir(lockPath);
  }
}

function requireLinkedCleanWorktree(context) {
  if (context.isPrimaryWorktree) {
    fail("Primary/shared checkout is forbidden; use a dedicated linked worktree");
  }
  if (context.dirty) fail("Worktree must be clean");
}

function verifyLeaseIdentity(context, lease, owner) {
  const checks = [
    [lease.ownerId, owner, "owner"],
    [lease.worktreePath, context.topLevel, "worktree path"],
    [lease.branch, context.branch, "branch"],
    [lease.headSha, context.headSha, "HEAD SHA"],
    [lease.headTree, context.headTree, "HEAD tree"],
    [lease.originMainSha, context.originMainSha, "origin/main SHA"],
    [lease.originMainTree, context.originMainTree, "origin/main tree"],
  ];
  for (const [expected, actual, label] of checks) {
    if (expected !== actual) fail(`Merge-owner lease ${label} drifted`);
  }
}

async function checkTask(context, argv) {
  requireLinkedCleanWorktree(context);
  if (context.branch === "main") {
    const owner = parseOwner(argv);
    verifyLeaseIdentity(context, await readLease(context.leasePath), owner);
    process.stdout.write("MERGE_OWNER_WORKTREE_OK\n");
    return;
  }
  if (!/^(?:codex|agent)\//.test(context.branch)) {
    fail("Task worktree branch must use codex/* or agent/*");
  }
  process.stdout.write("TASK_WORKTREE_OK\n");
}

async function claim(context, argv) {
  requireLinkedCleanWorktree(context);
  const owner = parseOwner(argv);
  const expectedMainSha = requiredArgument(argv, "--expected-main-sha", /^[0-9a-f]{40}$/);
  const expectedMainTree = requiredArgument(argv, "--expected-main-tree", /^[0-9a-f]{40}$/);
  if (context.branch !== "main") fail("Merge-owner lease can only be claimed from branch main");
  if (expectedMainSha !== context.originMainSha || expectedMainTree !== context.originMainTree) {
    fail("Explicit expected main SHA/tree does not match origin/main");
  }
  if (context.headSha !== context.originMainSha || context.headTree !== context.originMainTree) {
    fail("Branch main must exactly match frozen origin/main before claim");
  }
  const lease = {
    version: LEASE_VERSION,
    leaseId: randomUUID(),
    ownerId: owner,
    worktreePath: context.topLevel,
    branch: context.branch,
    headSha: context.headSha,
    headTree: context.headTree,
    originMainSha: context.originMainSha,
    originMainTree: context.originMainTree,
    claimedAt: new Date().toISOString(),
  };
  const temporaryPath = `${context.leasePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await handle.writeFile(`${JSON.stringify(lease, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporaryPath, context.leasePath);
  } catch (error) {
    if (error?.code === "EEXIST") {
      const existing = await readLease(context.leasePath);
      fail(`Merge-owner lease is already claimed by ${existing.ownerId}`);
    }
    throw error;
  } finally {
    await handle?.close();
    await unlink(temporaryPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
  process.stdout.write(`${JSON.stringify(lease)}\n`);
}

async function verify(context, argv) {
  requireLinkedCleanWorktree(context);
  const owner = parseOwner(argv);
  verifyLeaseIdentity(context, await readLease(context.leasePath), owner);
  process.stdout.write("MERGE_OWNER_LEASE_OK\n");
}

async function status(context) {
  const lease = await readLease(context.leasePath, { optional: true });
  process.stdout.write(lease ? `${JSON.stringify(lease)}\n` : "UNCLAIMED\n");
}

async function release(context, argv) {
  const owner = parseOwner(argv);
  const leaseId = requiredArgument(argv, "--lease-id", /^[0-9a-f-]{36}$/);
  const lease = await readLease(context.leasePath);
  if (lease.ownerId !== owner) fail("Only the matching merge owner may release the lease");
  if (lease.leaseId !== leaseId) fail("Lease generation mismatch; refusing to release a newer claim");
  if (lease.worktreePath !== context.topLevel) fail("Lease must be released from its claiming worktree");
  await unlink(context.leasePath);
  process.stdout.write("MERGE_OWNER_LEASE_RELEASED\n");
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  const context = await repositoryContext();
  if (command === "check-task") return checkTask(context, argv);
  if (command === "claim") return withMutationLock(context, async () => claim(await repositoryContext(), argv));
  if (command === "verify") return verify(context, argv);
  if (command === "status") return status(context);
  if (command === "release") return withMutationLock(context, async () => release(await repositoryContext(), argv));
  fail("Usage: codex_main_worktree_guard.mjs <check-task|claim|verify|status|release> --owner ID; claim also requires --expected-main-sha SHA --expected-main-tree TREE; release requires --lease-id UUID");
}

main().catch((error) => {
  process.stderr.write(`MERGE_OWNER_GUARD_BLOCKED: ${error.message}\n`);
  process.exitCode = 1;
});
