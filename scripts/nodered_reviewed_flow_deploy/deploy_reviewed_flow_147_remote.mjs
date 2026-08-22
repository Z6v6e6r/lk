#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertProtectedFile,
  assertProtectedFileModes,
  atomicWrite,
  sha256,
  validateReviewedFlowContract,
} from "./runtime_contract.mjs";

const LIVE_FLOW_PATH = "/root/.node-red/flows.json";
const STAGE_PARENT = "/root/.node-red";
const BACKUP_DIRECTORY = "/root/.node-red/.padlhub-reviewed-flow-backups";
const DEPLOYMENT_LOCK_PATH = "/root/.node-red/.padlhub-reviewed-flow-deploy.lock";
const DEPLOYMENT_LEASE_PATH = "/root/.node-red/.padlhub-reviewed-flow-deploy.lease.json";
const DEPLOYMENT_LOCK_HELD_ENV = "PADLHUB_REVIEWED_FLOW_LOCK_HELD";
const DEPLOYMENT_LOCK_CONFLICT_EXIT = 75;
const DEPLOYMENT_LEASE_FORMAT_VERSION = 1;
const DEFAULT_DEPLOYMENT_LEASE_MS = 15 * 60 * 1000;
const STAGE_PATTERN = /^\.padlhub-reviewed-flow-stage-\d{8}T\d{6}[+-]\d{4}-\d+$/;

const safeTimestamp = (value) => {
  const normalized = String(value || "");
  if (!/^\d{8}T\d{6}[+-]\d{4}$/.test(normalized)) {
    throw new Error("Timestamp must use YYYYMMDDTHHMMSS+ZZZZ");
  }
  return normalized;
};

const safeDeploymentId = (value) => {
  const normalized = String(value || "");
  if (!/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/.test(normalized)) {
    throw new Error("Deployment ID is invalid");
  }
  return normalized;
};

const runPm2Command = (args) => {
  const result = spawnSync("pm2", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) throw new Error(`PM2 command failed: pm2 ${args.join(" ")}`);
  return result.stdout;
};

export const createPm2Adapter = () => ({
  assertOnline() {
    const processes = JSON.parse(runPm2Command(["jlist"]));
    const matches = processes.filter((item) => item?.name === "node-red");
    if (matches.length !== 1) throw new Error("Expected exactly one PM2 node-red process");
    const processInfo = matches[0];
    if (processInfo?.pm2_env?.status !== "online") throw new Error("PM2 node-red process is not online");
    const result = {
      pid: Number(processInfo.pid),
      restartCount: Number(processInfo?.pm2_env?.restart_time),
    };
    if (!Number.isInteger(result.pid) || result.pid <= 0 || !Number.isInteger(result.restartCount) || result.restartCount < 0) {
      throw new Error("PM2 node-red process metadata is invalid");
    }
    return result;
  },
  restart(previousRestartCount) {
    runPm2Command(["restart", "node-red"]);
    const current = this.assertOnline();
    if (!Number.isInteger(current.restartCount) || current.restartCount <= previousRestartCount) {
      throw new Error("PM2 node-red restart counter did not advance");
    }
    return current;
  },
});

const assertProtectedDirectory = (directory, { uid, gid, mode }) => {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || stat.gid !== gid) {
    throw new Error(`Protected directory contract mismatch: ${directory}`);
  }
  if ((stat.mode & 0o777) !== mode) throw new Error(`Protected directory mode mismatch: ${directory}`);
};

export function createReviewedFlowRuntime({
  liveFlowPath = LIVE_FLOW_PATH,
  stageParent = STAGE_PARENT,
  backupDirectory = BACKUP_DIRECTORY,
  deploymentLeasePath = DEPLOYMENT_LEASE_PATH,
  deploymentLeaseMs = DEFAULT_DEPLOYMENT_LEASE_MS,
  uid = 0,
  gid = 0,
  getUid = () => process.getuid?.(),
  now = () => Date.now(),
  randomUUID = () => crypto.randomUUID(),
  pm2 = createPm2Adapter(),
} = {}) {
  const protectedFileOptions = { uid, gid, mode: 0o600 };
  if (!Number.isInteger(deploymentLeaseMs) || deploymentLeaseMs < 60_000 || deploymentLeaseMs > 60 * 60 * 1000) {
    throw new Error("Reviewed-flow deployment lease must be between 60 and 3600 seconds");
  }

  const assertRoot = () => {
    if (getUid() !== uid) throw new Error("Remote reviewed-flow installer must run as the protected owner");
  };

  const ensureBackupDirectory = () => {
    if (!fs.existsSync(backupDirectory)) {
      fs.mkdirSync(backupDirectory, { mode: 0o700 });
      fs.chownSync(backupDirectory, uid, gid);
    }
    assertProtectedDirectory(backupDirectory, { uid, gid, mode: 0o700 });
  };

  const readDeploymentLease = ({ includeExpired = false } = {}) => {
    assertRoot();
    if (!fs.existsSync(deploymentLeasePath)) return null;
    assertProtectedFile(deploymentLeasePath, protectedFileOptions);
    let lease;
    try {
      lease = JSON.parse(fs.readFileSync(deploymentLeasePath, "utf8"));
    } catch {
      throw new Error("Reviewed-flow deployment lease is invalid");
    }
    if (
      lease?.formatVersion !== DEPLOYMENT_LEASE_FORMAT_VERSION
      || safeDeploymentId(lease?.deploymentId) !== lease.deploymentId
      || typeof lease?.token !== "string"
      || !lease.token.trim()
      || !Number.isInteger(lease?.acquiredAtMs)
      || !Number.isInteger(lease?.expiresAtMs)
      || lease.expiresAtMs <= lease.acquiredAtMs
      || !/^[a-f0-9]{64}$/.test(String(lease?.sourceSha256 || ""))
      || !/^[a-f0-9]{64}$/.test(String(lease?.candidateSha256 || ""))
    ) {
      throw new Error("Reviewed-flow deployment lease contract mismatch");
    }
    if (!includeExpired && lease.expiresAtMs <= now()) {
      fs.unlinkSync(deploymentLeasePath);
      return null;
    }
    return lease;
  };

  const assertDeploymentLeaseAvailable = () => {
    const lease = readDeploymentLease();
    if (lease) {
      throw new Error(
        `Reviewed-flow deployment lease is active for ${lease.deploymentId} until ${new Date(lease.expiresAtMs).toISOString()}`,
      );
    }
  };

  const acquireDeploymentLease = (contract) => {
    assertDeploymentLeaseAvailable();
    const acquiredAtMs = now();
    const lease = {
      formatVersion: DEPLOYMENT_LEASE_FORMAT_VERSION,
      deploymentId: contract.deploymentId,
      token: randomUUID(),
      acquiredAtMs,
      expiresAtMs: acquiredAtMs + deploymentLeaseMs,
      sourceSha256: contract.sourceSha256,
      candidateSha256: contract.candidateSha256,
    };
    const descriptor = fs.openSync(
      deploymentLeasePath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      0o600,
    );
    try {
      fs.fchownSync(descriptor, uid, gid);
      fs.fchmodSync(descriptor, 0o600);
      fs.writeFileSync(descriptor, `${JSON.stringify(lease, null, 2)}\n`);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    assertProtectedFile(deploymentLeasePath, protectedFileOptions);
    return lease;
  };

  const releaseDeploymentLease = (expectedLease) => {
    const current = readDeploymentLease({ includeExpired: true });
    if (!current) return false;
    if (current.token !== expectedLease.token || current.deploymentId !== expectedLease.deploymentId) {
      throw new Error("Reviewed-flow deployment lease ownership mismatch");
    }
    fs.unlinkSync(deploymentLeasePath);
    return true;
  };

  const assertStagePath = (candidatePathValue, contractPathValue) => {
    const candidatePath = path.resolve(String(candidatePathValue || ""));
    const contractPath = path.resolve(String(contractPathValue || ""));
    const stageDirectory = path.dirname(candidatePath);
    if (
      path.dirname(stageDirectory) !== stageParent
      || !STAGE_PATTERN.test(path.basename(stageDirectory))
      || contractPath !== path.join(stageDirectory, "contract.json")
      || candidatePath !== path.join(stageDirectory, "candidate.flow.json")
    ) throw new Error("Staged candidate path is outside the reviewed deploy contract");
    assertProtectedDirectory(stageDirectory, { uid, gid, mode: 0o700 });
    assertProtectedFile(candidatePath, protectedFileOptions);
    assertProtectedFile(contractPath, protectedFileOptions);
    return { candidatePath, contractPath };
  };

  const readPrepared = (candidatePathValue, contractPathValue, expectedDeploymentId) => {
    assertRoot();
    const { candidatePath, contractPath } = assertStagePath(candidatePathValue, contractPathValue);
    assertProtectedFileModes(liveFlowPath, { uid, gid, modes: [0o600, 0o644] });
    const liveBytes = fs.readFileSync(liveFlowPath);
    const candidateBytes = fs.readFileSync(candidatePath);
    const contractBytes = fs.readFileSync(contractPath);
    const contract = JSON.parse(contractBytes.toString("utf8"));
    const deploymentId = safeDeploymentId(expectedDeploymentId);
    if (contract.deploymentId !== deploymentId) throw new Error("Deployment ID differs from reviewed contract");
    const validation = validateReviewedFlowContract({ liveBytes, candidateBytes, contract });
    return { liveBytes, candidateBytes, contractBytes, contract, validation };
  };

  const preflight = (options) => {
    assertDeploymentLeaseAvailable();
    const prepared = readPrepared(options.candidatePath, options.contractPath, options.deploymentId);
    const processInfo = pm2.assertOnline();
    return {
      ok: true,
      action: "preflight",
      deploymentId: prepared.contract.deploymentId,
      sourceSha256: prepared.contract.sourceSha256,
      candidateSha256: prepared.contract.candidateSha256,
      nodeCount: prepared.contract.nodeCount ?? prepared.contract.sourceNodeCount,
      candidateNodeCount: prepared.contract.candidateNodeCount ?? prepared.contract.nodeCount,
      httpInputCount: prepared.contract.httpInputCount,
      changedNodeCount: prepared.contract.allowedChanges.length,
      addedNodeCount: prepared.contract.allowedAdditions?.length ?? 0,
      nodeRedOnline: true,
      nodeRedPid: processInfo.pid,
      nodeRedRestartCount: processInfo.restartCount,
      deploymentLeaseAvailable: true,
      deploymentLeaseSeconds: deploymentLeaseMs / 1000,
    };
  };

  const apply = (options) => {
    const stamp = safeTimestamp(options.stamp);
    const prepared = readPrepared(options.candidatePath, options.contractPath, options.deploymentId);
    const beforeProcess = pm2.assertOnline();
    ensureBackupDirectory();
    const flowBackup = path.join(backupDirectory, `flows-pre-${prepared.contract.deploymentId}-${stamp}.json`);
    const contractBackup = path.join(backupDirectory, `contract-${prepared.contract.deploymentId}-${stamp}.json`);
    const deploymentLease = acquireDeploymentLease(prepared.contract);

    let published = false;
    try {
      fs.writeFileSync(flowBackup, prepared.liveBytes, { flag: "wx", mode: 0o600 });
      fs.chownSync(flowBackup, uid, gid);
      fs.writeFileSync(contractBackup, prepared.contractBytes, { flag: "wx", mode: 0o600 });
      fs.chownSync(contractBackup, uid, gid);
      if (sha256(fs.readFileSync(liveFlowPath)) !== prepared.contract.sourceSha256) {
        throw new Error("Live flow changed after backup and before publication");
      }
      atomicWrite(liveFlowPath, prepared.candidateBytes, { uid, gid });
      published = true;
      const processInfo = pm2.restart(beforeProcess.restartCount);
      const activeSha256 = sha256(fs.readFileSync(liveFlowPath));
      if (activeSha256 !== prepared.contract.candidateSha256) {
        throw new Error("Active flow digest differs from reviewed candidate");
      }
      return {
        ok: true,
        action: "apply",
        deploymentId: prepared.contract.deploymentId,
        sourceSha256: prepared.contract.sourceSha256,
        candidateSha256: prepared.contract.candidateSha256,
        activeFlowSha256: activeSha256,
        flowBackup,
        contractBackup,
        nodeRedOnline: true,
        nodeRedPid: processInfo.pid,
        nodeRedRestartCount: processInfo.restartCount,
        deploymentLeaseExpiresAt: new Date(deploymentLease.expiresAtMs).toISOString(),
        deploymentLeaseSeconds: deploymentLeaseMs / 1000,
      };
    } catch (error) {
      let rollbackComplete = !published;
      try {
        if (published) {
          atomicWrite(liveFlowPath, prepared.liveBytes, { uid, gid });
          pm2.restart(beforeProcess.restartCount);
          if (sha256(fs.readFileSync(liveFlowPath)) !== prepared.contract.sourceSha256) {
            throw new Error("automatic rollback did not restore the reviewed digest");
          }
          rollbackComplete = true;
        }
      } catch (rollbackError) {
        throw new Error(
          `Candidate failed; reviewed-flow rollback is incomplete and deployment lease remains active: ${rollbackError.message}`,
        );
      } finally {
        if (rollbackComplete) releaseDeploymentLease(deploymentLease);
      }
      throw new Error(`Candidate deployment failed; reviewed-flow rollback completed: ${error.message}`);
    }
  };

  const rollback = (options) => {
    assertRoot();
    const deploymentId = safeDeploymentId(options.deploymentId);
    const activeLease = readDeploymentLease();
    if (activeLease && activeLease.deploymentId !== deploymentId) {
      throw new Error(
        `Reviewed-flow deployment lease belongs to ${activeLease.deploymentId} until ${new Date(activeLease.expiresAtMs).toISOString()}`,
      );
    }
    const flowBackup = path.resolve(String(options.flowBackup || ""));
    const contractBackup = path.resolve(String(options.contractBackup || ""));
    const stampPattern = "\\d{8}T\\d{6}[+-]\\d{4}";
    const flowMatch = (new RegExp(`^flows-pre-${deploymentId}-(${stampPattern})\\.json$`)).exec(path.basename(flowBackup));
    const contractMatch = (new RegExp(`^contract-${deploymentId}-(${stampPattern})\\.json$`)).exec(path.basename(contractBackup));
    if (
      path.dirname(flowBackup) !== backupDirectory
      || path.dirname(contractBackup) !== backupDirectory
      || !flowMatch
      || !contractMatch
      || flowMatch[1] !== contractMatch[1]
    ) throw new Error("Rollback artifacts are outside the reviewed backup contract");
    assertProtectedFile(liveFlowPath, protectedFileOptions);
    assertProtectedFile(flowBackup, protectedFileOptions);
    assertProtectedFile(contractBackup, protectedFileOptions);
    const contract = JSON.parse(fs.readFileSync(contractBackup, "utf8"));
    if (contract.deploymentId !== deploymentId) throw new Error("Rollback deployment ID mismatch");
    if (
      activeLease
      && (
        activeLease.sourceSha256 !== contract.sourceSha256
        || activeLease.candidateSha256 !== contract.candidateSha256
      )
    ) {
      throw new Error("Reviewed-flow deployment lease digest mismatch");
    }
    const activeBytes = fs.readFileSync(liveFlowPath);
    const backupBytes = fs.readFileSync(flowBackup);
    if (sha256(activeBytes) !== contract.candidateSha256) {
      throw new Error("Active flow no longer matches the reviewed candidate selected for rollback");
    }
    if (sha256(backupBytes) !== contract.sourceSha256) throw new Error("Rollback flow digest mismatch");
    const beforeProcess = pm2.assertOnline();
    const rollbackLease = activeLease || acquireDeploymentLease(contract);
    atomicWrite(liveFlowPath, backupBytes, { uid, gid });
    const processInfo = pm2.restart(beforeProcess.restartCount);
    const restoredSha256 = sha256(fs.readFileSync(liveFlowPath));
    if (restoredSha256 !== contract.sourceSha256) throw new Error("Explicit rollback did not restore the reviewed digest");
    const deploymentLeaseReleased = releaseDeploymentLease(rollbackLease);
    return {
      ok: true,
      action: "rollback",
      deploymentId,
      rolledBackFromSha256: contract.candidateSha256,
      restoredFlowSha256: restoredSha256,
      flowBackup,
      contractBackup,
      nodeRedOnline: true,
      nodeRedPid: processInfo.pid,
      nodeRedRestartCount: processInfo.restartCount,
      deploymentLeaseReleased,
    };
  };

  return { preflight, apply, rollback };
}

const getArg = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};

export function main() {
  const action = process.argv[2];
  const runtime = createReviewedFlowRuntime();
  const common = {
    candidatePath: getArg("--candidate"),
    contractPath: getArg("--contract"),
    deploymentId: getArg("--deployment-id"),
  };
  const result = action === "preflight"
    ? runtime.preflight(common)
    : action === "apply"
      ? runtime.apply({ ...common, stamp: getArg("--stamp") })
      : action === "rollback"
        ? runtime.rollback({
          deploymentId: common.deploymentId,
          flowBackup: getArg("--flow-backup"),
          contractBackup: getArg("--contract-backup"),
        })
        : null;
  if (!result) throw new Error("Usage: deploy_reviewed_flow_147_remote.mjs <preflight|apply|rollback> [options]");
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

export function runCliWithDeploymentLock() {
  if (process.env[DEPLOYMENT_LOCK_HELD_ENV] === "1") {
    fs.chmodSync(DEPLOYMENT_LOCK_PATH, 0o600);
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      fs.chownSync(DEPLOYMENT_LOCK_PATH, 0, 0);
    }
    main();
    return;
  }

  const result = spawnSync(
    "flock",
    [
      "-E",
      String(DEPLOYMENT_LOCK_CONFLICT_EXIT),
      "-n",
      DEPLOYMENT_LOCK_PATH,
      process.execPath,
      fileURLToPath(import.meta.url),
      ...process.argv.slice(2),
    ],
    {
      env: { ...process.env, [DEPLOYMENT_LOCK_HELD_ENV]: "1" },
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  if (result.status === DEPLOYMENT_LOCK_CONFLICT_EXIT) {
    console.error("Another reviewed-flow deployment action holds the global lock");
  }
  if (!Number.isInteger(result.status)) throw new Error("Reviewed-flow deployment lock process did not exit cleanly");
  process.exitCode = result.status;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCliWithDeploymentLock();
}
