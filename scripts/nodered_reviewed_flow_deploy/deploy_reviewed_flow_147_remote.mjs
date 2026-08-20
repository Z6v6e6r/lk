#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertProtectedFile,
  atomicWrite,
  sha256,
  validateReviewedFlowContract,
} from "./runtime_contract.mjs";

const LIVE_FLOW_PATH = "/root/.node-red/flows.json";
const STAGE_PARENT = "/root/.node-red";
const BACKUP_DIRECTORY = "/root/.node-red/.padlhub-reviewed-flow-backups";
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
  uid = 0,
  gid = 0,
  getUid = () => process.getuid?.(),
  pm2 = createPm2Adapter(),
} = {}) {
  const protectedFileOptions = { uid, gid, mode: 0o600 };

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
    assertProtectedFile(liveFlowPath, protectedFileOptions);
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
    };
  };

  const apply = (options) => {
    const stamp = safeTimestamp(options.stamp);
    const prepared = readPrepared(options.candidatePath, options.contractPath, options.deploymentId);
    const beforeProcess = pm2.assertOnline();
    ensureBackupDirectory();
    const flowBackup = path.join(backupDirectory, `flows-pre-${prepared.contract.deploymentId}-${stamp}.json`);
    const contractBackup = path.join(backupDirectory, `contract-${prepared.contract.deploymentId}-${stamp}.json`);
    fs.writeFileSync(flowBackup, prepared.liveBytes, { flag: "wx", mode: 0o600 });
    fs.chownSync(flowBackup, uid, gid);
    fs.writeFileSync(contractBackup, prepared.contractBytes, { flag: "wx", mode: 0o600 });
    fs.chownSync(contractBackup, uid, gid);

    let published = false;
    try {
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
      };
    } catch (error) {
      if (published) {
        atomicWrite(liveFlowPath, prepared.liveBytes, { uid, gid });
        try {
          pm2.restart(beforeProcess.restartCount);
        } catch {
          throw new Error("Candidate failed; reviewed bytes were restored but Node-RED rollback restart failed");
        }
        if (sha256(fs.readFileSync(liveFlowPath)) !== prepared.contract.sourceSha256) {
          throw new Error("Candidate failed and automatic rollback did not restore the reviewed digest");
        }
      }
      throw new Error(`Candidate deployment failed; reviewed-flow rollback completed: ${error.message}`);
    }
  };

  const rollback = (options) => {
    assertRoot();
    const deploymentId = safeDeploymentId(options.deploymentId);
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
    const activeBytes = fs.readFileSync(liveFlowPath);
    const backupBytes = fs.readFileSync(flowBackup);
    if (sha256(activeBytes) !== contract.candidateSha256) {
      throw new Error("Active flow no longer matches the reviewed candidate selected for rollback");
    }
    if (sha256(backupBytes) !== contract.sourceSha256) throw new Error("Rollback flow digest mismatch");
    const beforeProcess = pm2.assertOnline();
    atomicWrite(liveFlowPath, backupBytes, { uid, gid });
    const processInfo = pm2.restart(beforeProcess.restartCount);
    const restoredSha256 = sha256(fs.readFileSync(liveFlowPath));
    if (restoredSha256 !== contract.sourceSha256) throw new Error("Explicit rollback did not restore the reviewed digest");
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
