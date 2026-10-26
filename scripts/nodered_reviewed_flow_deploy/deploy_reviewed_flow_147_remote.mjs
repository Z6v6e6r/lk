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
  canonicalFlowSha256,
  recoverAtomicExclusivePublication,
  sha256,
  syncDirectory,
  validateReviewedFlowContract,
  validateEditorPauseInjectsContract,
  writeFileExclusiveAtomicDurable,
  writeFileExclusiveDurable,
} from "./runtime_contract.mjs";

const LIVE_FLOW_PATH = "/root/.node-red/flows.json";
const STAGE_PARENT = "/root/.node-red";
const BACKUP_DIRECTORY = "/root/.node-red/.padlhub-reviewed-flow-backups";
const DEPLOYMENT_LOCK_PATH = "/root/.node-red/.padlhub-reviewed-flow-deploy.lock";
const DEPLOYMENT_LEASE_PATH = "/root/.node-red/.padlhub-reviewed-flow-deploy.lease.json";
const DEPLOYMENT_LOCK_HELD_ENV = "PADLHUB_REVIEWED_FLOW_LOCK_HELD";
const DEPLOYMENT_LOCK_CONFLICT_EXIT = 75;
const DEPLOYMENT_LEASE_FORMAT_VERSION = 2;
const EDITOR_DEPLOYMENT_LEASE_FORMAT_VERSION = 3;
const EDITOR_DEPLOYMENT_LEASE_KIND = "editor-modified-nodes";
const EDITOR_SOAK_MS = 15 * 60 * 1000;
const DEFAULT_DEPLOYMENT_LEASE_MS = 15 * 60 * 1000;
const DEFAULT_PM2_COMMAND_TIMEOUT_MS = 60 * 1000;
const SOURCE_ROLLBACK_SCHEDULING_MARGIN_MS = 60 * 1000;
const DEFAULT_SOURCE_ROLLBACK_BUDGET_MS = (
  3 * DEFAULT_PM2_COMMAND_TIMEOUT_MS + SOURCE_ROLLBACK_SCHEDULING_MARGIN_MS
);
const DEPLOYMENT_LEASE_PHASES = new Set(["applying", "soaking", "rollback-restart-required"]);
const EDITOR_DEPLOYMENT_LEASE_PHASES = new Set(["editor-reserved", "editor-soaking", "editor-owner-decision"]);
const LEGACY_DEPLOYMENT_LEASE_PHASE = "legacy-unknown";
const STAGE_PATTERN = /^\.padlhub-reviewed-flow-stage-\d{8}T\d{6}[+-]\d{4}-\d+$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

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

const safeSha256 = (value, label) => {
  const normalized = String(value || "");
  if (!SHA256_PATTERN.test(normalized)) throw new Error(`${label} SHA-256 is invalid`);
  return normalized;
};

export const createPm2Adapter = ({
  commandTimeoutMs = DEFAULT_PM2_COMMAND_TIMEOUT_MS,
  spawnCommand = spawnSync,
} = {}) => {
  if (!Number.isInteger(commandTimeoutMs) || commandTimeoutMs < 1_000 || commandTimeoutMs > 120_000) {
    throw new Error("PM2 command timeout must be between 1 and 120 seconds");
  }
  return {
    inspect() {
      const commandResult = spawnCommand("pm2", ["jlist"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: commandTimeoutMs,
      });
      if (commandResult.error) throw new Error("PM2 inspect did not complete within its runtime budget");
      if (commandResult.status !== 0) throw new Error("PM2 command failed: pm2 jlist");
      const processes = JSON.parse(commandResult.stdout);
      const matches = processes.filter((item) => item?.name === "node-red");
      if (matches.length !== 1) throw new Error("Expected exactly one PM2 node-red process");
      const processInfo = matches[0];
      const result = {
        pid: Number(processInfo.pid),
        status: String(processInfo?.pm2_env?.status || ""),
        restartCount: Number(processInfo?.pm2_env?.restart_time),
      };
      if (!Number.isInteger(result.pid) || result.pid < 0 || !result.status
        || !Number.isInteger(result.restartCount) || result.restartCount < 0) {
        throw new Error("PM2 node-red process metadata is invalid");
      }
      return result;
    },
    assertOnline() {
      const result = this.inspect();
      if (result.status !== "online" || result.pid <= 0) throw new Error("PM2 node-red process is not online");
      return result;
    },
    restart(previousRestartCount) {
      if (!Number.isInteger(previousRestartCount) || previousRestartCount < 0) {
        throw new Error("Previous PM2 node-red restart counter is invalid");
      }
      const result = spawnCommand("pm2", ["restart", "node-red"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: commandTimeoutMs,
      });
      if (result.error) throw new Error("PM2 restart did not complete within its runtime budget");
      if (result.status !== 0) throw new Error("PM2 command failed: pm2 restart node-red");
      const current = this.assertOnline();
      if (!Number.isInteger(current.restartCount) || current.restartCount <= previousRestartCount) {
        throw new Error("PM2 node-red restart counter did not advance");
      }
      return current;
    },
  };
};

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
  pm2CommandTimeoutMs = DEFAULT_PM2_COMMAND_TIMEOUT_MS,
  sourceRollbackBudgetMs = DEFAULT_SOURCE_ROLLBACK_BUDGET_MS,
  uid = 0,
  gid = 0,
  getUid = () => process.getuid?.(),
  now = () => Date.now(),
  randomUUID = () => crypto.randomUUID(),
  pm2 = createPm2Adapter({ commandTimeoutMs: pm2CommandTimeoutMs }),
} = {}) {
  const protectedFileOptions = { uid, gid, mode: 0o600 };
  if (!Number.isInteger(deploymentLeaseMs) || deploymentLeaseMs < 60_000 || deploymentLeaseMs > 60 * 60 * 1000) {
    throw new Error("Reviewed-flow deployment lease must be between 60 and 3600 seconds");
  }
  if (!Number.isInteger(pm2CommandTimeoutMs) || pm2CommandTimeoutMs < 1_000 || pm2CommandTimeoutMs > 120_000) {
    throw new Error("PM2 command timeout must be between 1 and 120 seconds");
  }
  const minimumSourceRollbackBudgetMs = (
    3 * pm2CommandTimeoutMs + SOURCE_ROLLBACK_SCHEDULING_MARGIN_MS
  );
  if (
    !Number.isInteger(sourceRollbackBudgetMs)
    || sourceRollbackBudgetMs < minimumSourceRollbackBudgetMs
    || sourceRollbackBudgetMs > 10 * 60 * 1000
  ) {
    throw new Error(
      `Source rollback runtime budget must cover three PM2 commands plus scheduling margin (${minimumSourceRollbackBudgetMs}ms minimum)`,
    );
  }

  const activationState = (contract) => {
    const boundary = contract?.activationBoundary;
    if (!boundary) return null;
    const notBeforeMs = Date.parse(boundary.notBefore);
    if (!Number.isFinite(notBeforeMs)) throw new Error("Reviewed activation boundary is invalid");
    return {
      ...boundary,
      notBeforeMs,
      remainingMs: notBeforeMs - now(),
    };
  };

  const assertActivationLead = (contract, requiredMs, action) => {
    const state = activationState(contract);
    if (!state) return null;
    if (state.remainingMs <= requiredMs) {
      throw new Error(
        `${action} is too close to the reviewed activation boundary; runtime_unverified and source rollback is refused`,
      );
    }
    return state;
  };

  const assertSourceRollbackWindow = (contract, action) => (
    assertActivationLead(contract, sourceRollbackBudgetMs, action)
  );

  const assertRoot = () => {
    if (getUid() !== uid) throw new Error("Remote reviewed-flow installer must run as the protected owner");
  };

  const ensureBackupDirectory = () => {
    if (!fs.existsSync(backupDirectory)) {
      fs.mkdirSync(backupDirectory, { mode: 0o700 });
      fs.chownSync(backupDirectory, uid, gid);
      fs.chmodSync(backupDirectory, 0o700);
      syncDirectory(path.dirname(backupDirectory));
    }
    assertProtectedDirectory(backupDirectory, { uid, gid, mode: 0o700 });
  };

  const unlinkDeploymentLease = () => {
    fs.unlinkSync(deploymentLeasePath);
    syncDirectory(path.dirname(deploymentLeasePath));
  };

  const readDeploymentLease = ({ includeExpired = false } = {}) => {
    assertRoot();
    if (!fs.existsSync(deploymentLeasePath)) return null;
    recoverAtomicExclusivePublication(deploymentLeasePath, protectedFileOptions);
    assertProtectedFile(deploymentLeasePath, protectedFileOptions);
    let lease;
    try {
      lease = JSON.parse(fs.readFileSync(deploymentLeasePath, "utf8"));
    } catch {
      throw new Error("Reviewed-flow deployment lease is invalid");
    }
    if (
      ![1, DEPLOYMENT_LEASE_FORMAT_VERSION, EDITOR_DEPLOYMENT_LEASE_FORMAT_VERSION].includes(lease?.formatVersion)
      || safeDeploymentId(lease?.deploymentId) !== lease.deploymentId
      || typeof lease?.token !== "string"
      || !lease.token.trim()
      || (
        lease.formatVersion === DEPLOYMENT_LEASE_FORMAT_VERSION
        && !DEPLOYMENT_LEASE_PHASES.has(lease?.phase)
      )
      || (
        lease.formatVersion === EDITOR_DEPLOYMENT_LEASE_FORMAT_VERSION
        && (lease?.kind !== EDITOR_DEPLOYMENT_LEASE_KIND || !EDITOR_DEPLOYMENT_LEASE_PHASES.has(lease?.phase))
      )
      || !Number.isInteger(lease?.acquiredAtMs)
      || !Number.isInteger(lease?.expiresAtMs)
      || lease.expiresAtMs <= lease.acquiredAtMs
      || !/^[a-f0-9]{64}$/.test(String(lease?.sourceSha256 || ""))
      || !/^[a-f0-9]{64}$/.test(String(lease?.candidateSha256 || ""))
    ) {
      throw new Error("Reviewed-flow deployment lease contract mismatch");
    }
    if (lease.formatVersion === 1) lease = { ...lease, phase: LEGACY_DEPLOYMENT_LEASE_PHASE };
    if (!includeExpired && lease.expiresAtMs <= now() && lease.phase === "soaking") {
      unlinkDeploymentLease();
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

  const assertNoEditorLease = () => {
    const lease = readDeploymentLease({ includeExpired: true });
    if (lease?.formatVersion === EDITOR_DEPLOYMENT_LEASE_FORMAT_VERSION) {
      throw new Error("Editor-modified-nodes lease requires owner decision; ordinary reviewed-flow action is refused");
    }
  };

  const acquireDeploymentLease = (contract, phase = "applying") => {
    assertDeploymentLeaseAvailable();
    if (!DEPLOYMENT_LEASE_PHASES.has(phase)) {
      throw new Error("Reviewed-flow deployment lease phase is invalid");
    }
    const acquiredAtMs = now();
    const lease = {
      formatVersion: DEPLOYMENT_LEASE_FORMAT_VERSION,
      deploymentId: contract.deploymentId,
      token: randomUUID(),
      phase,
      acquiredAtMs,
      expiresAtMs: acquiredAtMs + deploymentLeaseMs,
      sourceSha256: contract.sourceSha256,
      candidateSha256: contract.candidateSha256,
    };
    writeFileExclusiveAtomicDurable(
      deploymentLeasePath,
      Buffer.from(`${JSON.stringify(lease, null, 2)}\n`, "utf8"),
      protectedFileOptions,
    );
    assertProtectedFile(deploymentLeasePath, protectedFileOptions);
    return lease;
  };

  const refreshDeploymentLease = (expectedLease, contract, phase) => {
    const current = readDeploymentLease({ includeExpired: true });
    if (
      !current
      || current.token !== expectedLease.token
      || current.deploymentId !== expectedLease.deploymentId
    ) throw new Error("Reviewed-flow deployment lease ownership mismatch");
    if (
      current.deploymentId !== contract.deploymentId
      || current.sourceSha256 !== contract.sourceSha256
      || current.candidateSha256 !== contract.candidateSha256
    ) throw new Error("Reviewed-flow deployment lease digest mismatch");
    if (!DEPLOYMENT_LEASE_PHASES.has(phase)) {
      throw new Error("Reviewed-flow deployment lease phase is invalid");
    }
    const acquiredAtMs = now();
    const refreshed = {
      ...current,
      formatVersion: DEPLOYMENT_LEASE_FORMAT_VERSION,
      phase,
      acquiredAtMs,
      expiresAtMs: acquiredAtMs + deploymentLeaseMs,
    };
    atomicWrite(
      deploymentLeasePath,
      Buffer.from(`${JSON.stringify(refreshed, null, 2)}\n`, "utf8"),
      { uid, gid },
    );
    assertProtectedFile(deploymentLeasePath, protectedFileOptions);
    return refreshed;
  };

  const releaseDeploymentLease = (expectedLease) => {
    const current = readDeploymentLease({ includeExpired: true });
    if (!current) return false;
    if (current.token !== expectedLease.token || current.deploymentId !== expectedLease.deploymentId) {
      throw new Error("Reviewed-flow deployment lease ownership mismatch");
    }
    unlinkDeploymentLease();
    return true;
  };

  const resolveBackupArtifacts = (options, actionLabel) => {
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
    ) throw new Error(`${actionLabel} artifacts are outside the reviewed backup contract`);
    return { deploymentId, flowBackup, contractBackup, artifactStamp: flowMatch[1] };
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
    const activation = assertActivationLead(
      prepared.contract,
      deploymentLeaseMs + sourceRollbackBudgetMs,
      "Preflight",
    );
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
      ...(activation ? {
        activationNotBefore: activation.notBefore,
        activationLeadSeconds: Math.floor(activation.remainingMs / 1000),
        sourceRollbackBudgetSeconds: sourceRollbackBudgetMs / 1000,
      } : {}),
    };
  };

  const apply = (options) => {
    const stamp = safeTimestamp(options.stamp);
    // A v3 editor lease is a custody boundary; reject it before inspecting any
    // ordinary candidate or reaching a path that could later publish/restart.
    assertDeploymentLeaseAvailable();
    const prepared = readPrepared(options.candidatePath, options.contractPath, options.deploymentId);
    assertActivationLead(
      prepared.contract,
      deploymentLeaseMs + sourceRollbackBudgetMs,
      "Apply",
    );
    const beforeProcess = pm2.assertOnline();
    ensureBackupDirectory();
    const flowBackup = path.join(backupDirectory, `flows-pre-${prepared.contract.deploymentId}-${stamp}.json`);
    const contractBackup = path.join(backupDirectory, `contract-${prepared.contract.deploymentId}-${stamp}.json`);
    const candidateBackup = path.join(backupDirectory, `candidate-${prepared.contract.deploymentId}-${stamp}.flow.json`);
    writeFileExclusiveDurable(flowBackup, prepared.liveBytes, protectedFileOptions);
    writeFileExclusiveDurable(contractBackup, prepared.contractBytes, protectedFileOptions);
    writeFileExclusiveDurable(candidateBackup, prepared.candidateBytes, protectedFileOptions);
    let deploymentLease = acquireDeploymentLease(prepared.contract);

    let restartAttempted = false;
    try {
      if (sha256(fs.readFileSync(liveFlowPath)) !== prepared.contract.sourceSha256) {
        throw new Error("Live flow changed after backup and before publication");
      }
      assertActivationLead(
        prepared.contract,
        deploymentLeaseMs + sourceRollbackBudgetMs,
        "Candidate publication",
      );
      atomicWrite(liveFlowPath, prepared.candidateBytes, { uid, gid });
      restartAttempted = true;
      const processInfo = pm2.restart(beforeProcess.restartCount);
      const activeSha256 = sha256(fs.readFileSync(liveFlowPath));
      if (activeSha256 !== prepared.contract.candidateSha256) {
        throw new Error("Active flow digest differs from reviewed candidate");
      }
      assertActivationLead(
        prepared.contract,
        deploymentLeaseMs + sourceRollbackBudgetMs,
        "Candidate soak lease refresh",
      );
      deploymentLease = refreshDeploymentLease(deploymentLease, prepared.contract, "soaking");
      return {
        ok: true,
        action: "apply",
        deploymentId: prepared.contract.deploymentId,
        sourceSha256: prepared.contract.sourceSha256,
        candidateSha256: prepared.contract.candidateSha256,
        activeFlowSha256: activeSha256,
        flowBackup,
        contractBackup,
        candidateBackup,
        nodeRedOnline: true,
        nodeRedPid: processInfo.pid,
        nodeRedRestartCount: processInfo.restartCount,
        deploymentLeaseExpiresAt: new Date(deploymentLease.expiresAtMs).toISOString(),
        deploymentLeaseSeconds: deploymentLeaseMs / 1000,
      };
    } catch (error) {
      let rollbackComplete = false;
      try {
        // rename may have published the candidate even when its directory fsync
        // threw. Only protected on-disk bytes can establish the recovery state.
        assertProtectedFileModes(liveFlowPath, { uid, gid, modes: [0o600, 0o644] });
        const recoverySha256 = sha256(fs.readFileSync(liveFlowPath));
        const candidateActive = recoverySha256 === prepared.contract.candidateSha256;
        if (!candidateActive && recoverySha256 !== prepared.contract.sourceSha256) {
          throw new Error("active flow is neither the reviewed source nor candidate");
        }
        if (candidateActive || restartAttempted) {
          deploymentLease = refreshDeploymentLease(
            deploymentLease,
            prepared.contract,
            "rollback-restart-required",
          );
          if (candidateActive) {
            assertSourceRollbackWindow(prepared.contract, "Automatic source rollback");
            atomicWrite(liveFlowPath, prepared.liveBytes, { uid, gid });
          } else {
            assertSourceRollbackWindow(prepared.contract, "Automatic source restart");
          }
          const rollbackProcess = pm2.inspect();
          pm2.restart(rollbackProcess.restartCount);
        }
        if (sha256(fs.readFileSync(liveFlowPath)) !== prepared.contract.sourceSha256) {
          throw new Error("automatic rollback did not restore the reviewed digest");
        }
        pm2.assertOnline();
        rollbackComplete = true;
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
    assertNoEditorLease();
    const { deploymentId, flowBackup, contractBackup } = resolveBackupArtifacts(options, "Rollback");
    const activeLease = readDeploymentLease({ includeExpired: true });
    if (activeLease && activeLease.deploymentId !== deploymentId) {
      throw new Error(
        `Reviewed-flow deployment lease belongs to ${activeLease.deploymentId} until ${new Date(activeLease.expiresAtMs).toISOString()}`,
      );
    }
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
    const activeSha256 = sha256(activeBytes);
    const isCandidateActive = activeSha256 === contract.candidateSha256;
    const isSourceActive = activeSha256 === contract.sourceSha256;
    if (!isCandidateActive && !isSourceActive) {
      throw new Error("Active flow no longer matches the reviewed candidate selected for rollback");
    }
    assertSourceRollbackWindow(contract, "Explicit source rollback");
    if (isSourceActive && !activeLease) {
      throw new Error("Reviewed source is active without a matching deployment lease; rollback resume is refused");
    }
    if (isSourceActive && activeLease?.phase === "soaking") {
      throw new Error("Reviewed source is active under a soaking lease; rollback state is ambiguous");
    }
    if (sha256(backupBytes) !== contract.sourceSha256) throw new Error("Rollback flow digest mismatch");
    if (isSourceActive && activeLease?.phase === "applying") {
      const processInfo = pm2.assertOnline();
      const deploymentLeaseReleased = releaseDeploymentLease(activeLease);
      return {
        ok: true,
        action: "rollback",
        deploymentId,
        rolledBackFromSha256: null,
        restoredFlowSha256: activeSha256,
        flowBackup,
        contractBackup,
        nodeRedOnline: true,
        nodeRedPid: processInfo.pid,
        nodeRedRestartCount: processInfo.restartCount,
        restartCountBefore: processInfo.restartCount,
        rollbackMode: "no-publication-release",
        resumedIncompleteRollback: true,
        deploymentLeaseReleased,
      };
    }
    const rollbackLease = activeLease
      ? refreshDeploymentLease(activeLease, contract, "rollback-restart-required")
      : acquireDeploymentLease(contract, "rollback-restart-required");
    if (isCandidateActive) {
      assertSourceRollbackWindow(contract, "Explicit source publication");
      atomicWrite(liveFlowPath, backupBytes, { uid, gid });
    }
    const beforeRestart = pm2.inspect();
    const processInfo = pm2.restart(beforeRestart.restartCount);
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
      restartCountBefore: beforeRestart.restartCount,
      rollbackMode: isCandidateActive ? "restore-and-restart" : "resume-restart",
      resumedIncompleteRollback: isSourceActive,
      deploymentLeaseReleased,
    };
  };

  const reconcileCurrent = (options) => {
    assertRoot();
    assertNoEditorLease();
    const stamp = safeTimestamp(options.stamp);
    const { deploymentId, flowBackup, contractBackup, artifactStamp } = resolveBackupArtifacts(
      options,
      "Current candidate reconciliation",
    );
    const candidateBackup = path.resolve(String(options.candidateBackup || ""));
    if (
      path.dirname(candidateBackup) !== backupDirectory
      || path.basename(candidateBackup) !== `candidate-${deploymentId}-${artifactStamp}.flow.json`
    ) throw new Error("Current candidate backup is outside the reviewed backup contract");
    assertProtectedFile(liveFlowPath, protectedFileOptions);
    assertProtectedFile(flowBackup, protectedFileOptions);
    assertProtectedFile(contractBackup, protectedFileOptions);
    assertProtectedFile(candidateBackup, protectedFileOptions);
    const activeBytes = fs.readFileSync(liveFlowPath);
    const backupBytes = fs.readFileSync(flowBackup);
    const candidateBackupBytes = fs.readFileSync(candidateBackup);
    const contractBytes = fs.readFileSync(contractBackup);
    const contract = JSON.parse(contractBytes.toString("utf8"));
    if (contract.deploymentId !== deploymentId) {
      throw new Error("Current candidate reconciliation contract deployment mismatch");
    }
    const activeSha256 = sha256(activeBytes);
    if (![contract.sourceSha256, contract.candidateSha256].includes(activeSha256)) {
      throw new Error("Current candidate reconciliation requires the exact reviewed source or candidate on disk");
    }
    if (sha256(backupBytes) !== contract.sourceSha256) {
      throw new Error("Current candidate reconciliation source backup digest mismatch");
    }
    if (sha256(candidateBackupBytes) !== contract.candidateSha256) {
      throw new Error("Current candidate reconciliation candidate backup digest mismatch");
    }
    validateReviewedFlowContract({ liveBytes: backupBytes, candidateBytes: candidateBackupBytes, contract });
    const intentPath = path.join(
      backupDirectory,
      `reconcile-current-intent-${deploymentId}-${stamp}.json`,
    );
    const receiptPath = path.join(
      backupDirectory,
      `reconcile-current-success-${deploymentId}-${stamp}.json`,
    );
    const verifiedPath = path.join(
      backupDirectory,
      `reconcile-current-verified-${deploymentId}-${stamp}.json`,
    );
    const activeLease = readDeploymentLease({ includeExpired: true });
    const receiptBase = {
      formatVersion: 1,
      action: "reconcile-current",
      deploymentId,
      sourceSha256: contract.sourceSha256,
      candidateSha256: contract.candidateSha256,
      contractSha256: sha256(contractBytes),
      flowBackupSha256: sha256(backupBytes),
      candidateBackupSha256: sha256(candidateBackupBytes),
    };
    const readReceipt = (filePath) => {
      assertProtectedFile(filePath, protectedFileOptions);
      try {
        return JSON.parse(fs.readFileSync(filePath, "utf8"));
      } catch {
        throw new Error(`Current candidate reconciliation receipt is invalid: ${filePath}`);
      }
    };
    const assertReceipt = (value, state) => {
      if (!value || typeof value !== "object" || Array.isArray(value) || value.state !== state) {
        throw new Error(`Current candidate reconciliation ${state} receipt state mismatch`);
      }
      for (const [key, expected] of Object.entries(receiptBase)) {
        if (value[key] !== expected) {
          throw new Error(`Current candidate reconciliation ${state} receipt mismatch: ${key}`);
        }
      }
      safeSha256(value.leaseSha256, "Reconciliation lease");
      if (state !== "VERIFICATION_PENDING") {
        if (
          value.intentPath !== intentPath
          || !Number.isInteger(value.nodeRedPid)
          || value.nodeRedPid <= 0
          || !Number.isInteger(value.nodeRedRestartCount)
          || value.nodeRedRestartCount < 0
          || !Number.isInteger(value.restartCountBefore)
          || value.restartCountBefore < 0
        ) throw new Error(`Current candidate reconciliation ${state} runtime receipt mismatch`);
      }
      if (
        state === "SUCCESS"
        && (value.verifiedPath !== verifiedPath || value.deploymentLeaseReleased !== true)
      ) throw new Error("Current candidate reconciliation success receipt mismatch");
      return value;
    };
    const resultFromReceipt = (receipt, extra = {}) => ({
      ok: true,
      action: "reconcile-current",
      deploymentId,
      activeFlowSha256: contract.candidateSha256,
      candidateBackup,
      intentPath,
      verifiedPath,
      receiptPath,
      receiptSha256: sha256(fs.readFileSync(receiptPath)),
      nodeRedOnline: true,
      nodeRedPid: receipt.nodeRedPid,
      nodeRedRestartCount: receipt.nodeRedRestartCount,
      restartCountBefore: receipt.restartCountBefore,
      deploymentLeaseReleased: true,
      ...extra,
    });

    if (fs.existsSync(receiptPath)) {
      if (!fs.existsSync(intentPath) || !fs.existsSync(verifiedPath)) {
        throw new Error("Current candidate reconciliation success receipt chain is incomplete");
      }
      assertReceipt(readReceipt(intentPath), "VERIFICATION_PENDING");
      assertReceipt(readReceipt(verifiedPath), "VERIFIED_PENDING_RELEASE");
      const receipt = assertReceipt(readReceipt(receiptPath), "SUCCESS");
      if (activeLease) throw new Error("Current candidate reconciliation success conflicts with an active lease");
      if (activeSha256 !== contract.candidateSha256) {
        throw new Error("Current candidate reconciliation success no longer matches active candidate bytes");
      }
      const processInfo = pm2.assertOnline();
      if (
        processInfo.pid !== receipt.nodeRedPid
        || processInfo.restartCount !== receipt.nodeRedRestartCount
      ) throw new Error("Current candidate reconciliation success no longer matches Node-RED identity");
      return resultFromReceipt(receipt, { resumedSuccess: true });
    }

    if (fs.existsSync(verifiedPath)) {
      if (!fs.existsSync(intentPath)) {
        throw new Error("Current candidate reconciliation verified receipt has no pending intent");
      }
      assertReceipt(readReceipt(intentPath), "VERIFICATION_PENDING");
      const verified = assertReceipt(readReceipt(verifiedPath), "VERIFIED_PENDING_RELEASE");
      if (activeSha256 !== contract.candidateSha256) {
        throw new Error("Current candidate reconciliation verified receipt no longer matches active candidate bytes");
      }
      const processInfo = pm2.assertOnline();
      if (
        processInfo.pid !== verified.nodeRedPid
        || processInfo.restartCount !== verified.nodeRedRestartCount
      ) throw new Error("Current candidate reconciliation verified receipt no longer matches Node-RED identity");
      if (activeLease) {
        if (
          activeLease.formatVersion !== DEPLOYMENT_LEASE_FORMAT_VERSION
          || activeLease.phase !== "rollback-restart-required"
          || activeLease.deploymentId !== deploymentId
          || activeLease.sourceSha256 !== contract.sourceSha256
          || activeLease.candidateSha256 !== contract.candidateSha256
          || sha256(fs.readFileSync(deploymentLeasePath)) !== verified.leaseSha256
        ) throw new Error("Current candidate reconciliation verified receipt conflicts with the active lease");
        releaseDeploymentLease(activeLease);
      }
      const receipt = {
        ...verified,
        state: "SUCCESS",
        verifiedPath,
        deploymentLeaseReleased: true,
        completedAt: new Date(now()).toISOString(),
      };
      writeFileExclusiveDurable(
        receiptPath,
        Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8"),
        protectedFileOptions,
      );
      assertProtectedFile(receiptPath, protectedFileOptions);
      return resultFromReceipt(receipt, { resumedVerified: true });
    }

    if (fs.existsSync(intentPath)) {
      throw new Error("Current candidate reconciliation pending intent requires a new reconciliation stamp");
    }
    if (
      !activeLease
      || activeLease.formatVersion !== DEPLOYMENT_LEASE_FORMAT_VERSION
      || activeLease.phase !== "rollback-restart-required"
      || activeLease.deploymentId !== deploymentId
      || activeLease.sourceSha256 !== contract.sourceSha256
      || activeLease.candidateSha256 !== contract.candidateSha256
    ) throw new Error("Current candidate reconciliation requires the matching incomplete-restart lease");
    const expectedLeaseSha256 = sha256(fs.readFileSync(deploymentLeasePath));

    const intent = {
      ...receiptBase,
      state: "VERIFICATION_PENDING",
      leaseSha256: expectedLeaseSha256,
      createdAt: new Date(now()).toISOString(),
    };
    writeFileExclusiveDurable(
      intentPath,
      Buffer.from(`${JSON.stringify(intent, null, 2)}\n`, "utf8"),
      protectedFileOptions,
    );
    assertProtectedFile(intentPath, protectedFileOptions);

    if (activeSha256 === contract.sourceSha256) {
      atomicWrite(liveFlowPath, candidateBackupBytes, { uid, gid });
    }

    const beforeRestart = pm2.inspect();
    const processInfo = pm2.restart(beforeRestart.restartCount);
    if (sha256(fs.readFileSync(liveFlowPath)) !== contract.candidateSha256) {
      throw new Error("Current candidate changed during runtime reconciliation");
    }
    if (sha256(fs.readFileSync(deploymentLeasePath)) !== expectedLeaseSha256) {
      throw new Error("Deployment lease changed during current candidate reconciliation");
    }
    if (
      sha256(fs.readFileSync(liveFlowPath)) !== contract.candidateSha256
      || sha256(fs.readFileSync(flowBackup)) !== contract.sourceSha256
      || sha256(fs.readFileSync(candidateBackup)) !== contract.candidateSha256
      || sha256(fs.readFileSync(contractBackup)) !== sha256(contractBytes)
      || sha256(fs.readFileSync(deploymentLeasePath)) !== expectedLeaseSha256
    ) throw new Error("Current candidate reconciliation state changed before lease release");
    const finalProcessInfo = pm2.assertOnline();
    if (
      finalProcessInfo.pid !== processInfo.pid
      || finalProcessInfo.restartCount !== processInfo.restartCount
    ) throw new Error("Node-RED process identity changed before reconciliation lease release");
    const verified = {
      ...intent,
      state: "VERIFIED_PENDING_RELEASE",
      intentPath,
      nodeRedPid: processInfo.pid,
      nodeRedRestartCount: processInfo.restartCount,
      restartCountBefore: beforeRestart.restartCount,
      verifiedAt: new Date(now()).toISOString(),
    };
    writeFileExclusiveDurable(
      verifiedPath,
      Buffer.from(`${JSON.stringify(verified, null, 2)}\n`, "utf8"),
      protectedFileOptions,
    );
    assertProtectedFile(verifiedPath, protectedFileOptions);
    if (
      sha256(fs.readFileSync(liveFlowPath)) !== contract.candidateSha256
      || sha256(fs.readFileSync(deploymentLeasePath)) !== expectedLeaseSha256
    ) throw new Error("Current candidate reconciliation changed after verified receipt");
    const deploymentLeaseReleased = releaseDeploymentLease(activeLease);
    const receipt = {
      ...verified,
      state: "SUCCESS",
      verifiedPath,
      deploymentLeaseReleased,
      completedAt: new Date(now()).toISOString(),
    };
    writeFileExclusiveDurable(
      receiptPath,
      Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8"),
      protectedFileOptions,
    );
    assertProtectedFile(receiptPath, protectedFileOptions);
    return {
      ok: true,
      action: "reconcile-current",
      deploymentId,
      activeFlowSha256: contract.candidateSha256,
      candidateBackup,
      intentPath,
      verifiedPath,
      receiptPath,
      receiptSha256: sha256(fs.readFileSync(receiptPath)),
      nodeRedOnline: true,
      nodeRedPid: processInfo.pid,
      nodeRedRestartCount: processInfo.restartCount,
      restartCountBefore: beforeRestart.restartCount,
      deploymentLeaseReleased,
    };
  };

  const finalizeLegacyCandidate = (options) => {
    assertRoot();
    assertNoEditorLease();
    const stamp = safeTimestamp(options.stamp);
    const artifacts = resolveBackupArtifacts(options, "Legacy finalization");
    const expectedLeaseSha256 = safeSha256(options.expectedLeaseSha256, "Expected lease");
    const expectedActiveSha256 = safeSha256(options.expectedActiveSha256, "Expected active flow");
    const expectedFlowBackupSha256 = safeSha256(
      options.expectedFlowBackupSha256,
      "Expected flow backup",
    );
    const expectedContractBackupSha256 = safeSha256(
      options.expectedContractBackupSha256,
      "Expected contract backup",
    );
    if (stamp === artifacts.artifactStamp) {
      throw new Error("Legacy finalization receipt stamp must differ from the deployment artifact stamp");
    }

    assertProtectedDirectory(backupDirectory, { uid, gid, mode: 0o700 });
    assertProtectedFileModes(liveFlowPath, { uid, gid, modes: [0o600, 0o644] });
    assertProtectedFile(artifacts.flowBackup, protectedFileOptions);
    assertProtectedFile(artifacts.contractBackup, protectedFileOptions);
    const activeBytes = fs.readFileSync(liveFlowPath);
    const flowBackupBytes = fs.readFileSync(artifacts.flowBackup);
    const contractBackupBytes = fs.readFileSync(artifacts.contractBackup);
    const activeFlowSha256 = sha256(activeBytes);
    const flowBackupSha256 = sha256(flowBackupBytes);
    const contractBackupSha256 = sha256(contractBackupBytes);
    if (activeFlowSha256 !== expectedActiveSha256) {
      throw new Error("Active flow differs from the frozen legacy finalization digest");
    }
    if (flowBackupSha256 !== expectedFlowBackupSha256) {
      throw new Error("Flow backup differs from the frozen legacy finalization digest");
    }
    if (contractBackupSha256 !== expectedContractBackupSha256) {
      throw new Error("Contract backup differs from the frozen legacy finalization digest");
    }
    let contract;
    try {
      contract = JSON.parse(contractBackupBytes.toString("utf8"));
    } catch {
      throw new Error("Legacy finalization contract backup is invalid");
    }
    if (contract.deploymentId !== artifacts.deploymentId) {
      throw new Error("Legacy finalization deployment ID mismatch");
    }
    if (
      contract.sourceSha256 !== expectedFlowBackupSha256
      || contract.candidateSha256 !== expectedActiveSha256
    ) throw new Error("Legacy finalization contract digest mismatch");
    validateReviewedFlowContract({
      liveBytes: flowBackupBytes,
      candidateBytes: activeBytes,
      contract,
    });

    const receiptPath = path.join(
      backupDirectory,
      `legacy-v1-candidate-finalization-${artifacts.deploymentId}-${stamp}.json`,
    );
    const activeLease = readDeploymentLease({ includeExpired: true });
    if (activeLease) {
      if (activeLease.deploymentId !== artifacts.deploymentId) {
        throw new Error(`Reviewed-flow deployment lease belongs to ${activeLease.deploymentId}`);
      }
      if (activeLease.formatVersion !== 1 || activeLease.phase !== LEGACY_DEPLOYMENT_LEASE_PHASE) {
        throw new Error("Legacy candidate finalization requires a formatVersion 1 deployment lease");
      }
      if (activeLease.expiresAtMs > now()) {
        throw new Error("Legacy candidate finalization requires an expired deployment lease");
      }
      if (
        activeLease.sourceSha256 !== contract.sourceSha256
        || activeLease.candidateSha256 !== contract.candidateSha256
      ) throw new Error("Reviewed-flow deployment lease digest mismatch");
      if (sha256(fs.readFileSync(deploymentLeasePath)) !== expectedLeaseSha256) {
        throw new Error("Deployment lease differs from the frozen legacy finalization digest");
      }
    } else if (!fs.existsSync(receiptPath)) {
      throw new Error("Legacy candidate finalization requires the frozen deployment lease");
    }

    const processInfo = pm2.assertOnline();
    const receiptContract = {
      formatVersion: 1,
      action: "finalize-legacy-v1-candidate",
      deploymentId: artifacts.deploymentId,
      stamp,
      artifactStamp: artifacts.artifactStamp,
      legacyLeaseSha256: expectedLeaseSha256,
      sourceSha256: contract.sourceSha256,
      candidateSha256: contract.candidateSha256,
      activeFlowSha256,
      flowBackupSha256,
      contractBackupSha256,
      flowBackup: artifacts.flowBackup,
      contractBackup: artifacts.contractBackup,
      nodeRedPid: processInfo.pid,
      nodeRedRestartCount: processInfo.restartCount,
      activeCandidateAdopted: true,
      flowChanged: false,
      nodeRedRestarted: false,
    };
    let alreadyFinalized = false;
    if (fs.existsSync(receiptPath)) {
      assertProtectedFile(receiptPath, protectedFileOptions);
      let receipt;
      try {
        receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
      } catch {
        throw new Error("Legacy candidate finalization receipt is invalid");
      }
      for (const [key, value] of Object.entries(receiptContract)) {
        if (key === "nodeRedPid" || key === "nodeRedRestartCount") continue;
        if (receipt?.[key] !== value) {
          throw new Error("Legacy candidate finalization receipt contract mismatch");
        }
      }
      if (
        !Number.isInteger(receipt?.nodeRedPid)
        || receipt.nodeRedPid <= 0
        || !Number.isInteger(receipt?.nodeRedRestartCount)
        || receipt.nodeRedRestartCount < 0
      ) throw new Error("Legacy candidate finalization receipt process metadata is invalid");
      alreadyFinalized = true;
    } else {
      writeFileExclusiveDurable(
        receiptPath,
        Buffer.from(`${JSON.stringify(receiptContract, null, 2)}\n`, "utf8"),
        protectedFileOptions,
      );
      assertProtectedFile(receiptPath, protectedFileOptions);
    }

    if (
      sha256(fs.readFileSync(liveFlowPath)) !== expectedActiveSha256
      || sha256(fs.readFileSync(artifacts.flowBackup)) !== expectedFlowBackupSha256
      || sha256(fs.readFileSync(artifacts.contractBackup)) !== expectedContractBackupSha256
    ) throw new Error("Legacy candidate finalization state changed before lease release");
    const finalProcessInfo = pm2.assertOnline();
    if (
      finalProcessInfo.pid !== processInfo.pid
      || finalProcessInfo.restartCount !== processInfo.restartCount
    ) throw new Error("Node-RED process identity changed before legacy lease release");
    if (
      activeLease
      && sha256(fs.readFileSync(deploymentLeasePath)) !== expectedLeaseSha256
    ) throw new Error("Deployment lease changed before legacy finalization release");
    const deploymentLeaseReleased = activeLease ? releaseDeploymentLease(activeLease) : false;
    return {
      ok: true,
      action: "finalize-legacy-v1-candidate",
      deploymentId: artifacts.deploymentId,
      activeFlowSha256,
      receiptPath,
      receiptSha256: sha256(fs.readFileSync(receiptPath)),
      activeCandidateAdopted: true,
      flowChanged: false,
      nodeRedRestarted: false,
      nodeRedOnline: true,
      nodeRedPid: processInfo.pid,
      nodeRedRestartCount: processInfo.restartCount,
      deploymentLeaseReleased,
      alreadyFinalized,
    };
  };

  const readEditorPrepared = (options) => {
    assertRoot();
    const { candidatePath, contractPath } = assertStagePath(options.candidatePath, options.contractPath);
    assertProtectedFileModes(liveFlowPath, { uid, gid, modes: [0o600, 0o644] });
    const liveBytes = fs.readFileSync(liveFlowPath);
    const candidateBytes = fs.readFileSync(candidatePath);
    const contractBytes = fs.readFileSync(contractPath);
    let contract;
    try { contract = JSON.parse(contractBytes.toString("utf8")); } catch { throw new Error("Editor pause contract is invalid"); }
    if (contract.deploymentId !== safeDeploymentId(options.deploymentId)) throw new Error("Editor pause deployment ID differs from contract");
    validateEditorPauseInjectsContract({ liveBytes, candidateBytes, contract });
    return { liveBytes, candidateBytes, contractBytes, contract, candidatePath, contractPath };
  };

  const editorReceiptPath = (name, deploymentId, stamp) => path.join(
    backupDirectory,
    `editor-${name}-${deploymentId}-${stamp}.json`,
  );
  const assertEditorLease = (options, phases) => {
    const lease = readDeploymentLease({ includeExpired: true });
    if (!lease || lease.formatVersion !== EDITOR_DEPLOYMENT_LEASE_FORMAT_VERSION
      || lease.kind !== EDITOR_DEPLOYMENT_LEASE_KIND
      || lease.deploymentId !== safeDeploymentId(options.deploymentId)
      || lease.token !== String(options.leaseToken || "")
      || !phases.has(lease.phase)) {
      throw new Error("Editor-modified-nodes lease ownership or phase mismatch");
    }
    return lease;
  };
  const assertEditorRuntime = (lease) => {
    const processInfo = pm2.assertOnline();
    if (processInfo.pid !== lease.nodeRedPid || processInfo.restartCount !== lease.nodeRedRestartCount) {
      throw new Error("Editor-modified-nodes Node-RED identity drift; lease retained for owner decision");
    }
    return processInfo;
  };
  const writeEditorLease = (lease) => {
    atomicWrite(deploymentLeasePath, Buffer.from(`${JSON.stringify(lease, null, 2)}\n`, "utf8"), { uid, gid });
    assertProtectedFile(deploymentLeasePath, protectedFileOptions);
    return lease;
  };
  const leaseTokenSha256 = (lease) => sha256(Buffer.from(lease.token, "utf8"));
  const readJsonArtifact = (filePath, label) => {
    let descriptor;
    try {
      descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid || stat.gid !== gid || (stat.mode & 0o777) !== 0o600) {
        throw new Error(`${label} protection mismatch`);
      }
      const bytes = fs.readFileSync(descriptor);
      return { value: JSON.parse(bytes.toString("utf8")), sha256: sha256(bytes) };
    } catch (error) {
      if (error?.message?.endsWith("protection mismatch")) throw error;
      throw new Error(`${label} is invalid`);
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  };
  const assertEditorStageArtifact = (filePathValue, candidatePath, expectedName, label) => {
    const filePath = path.resolve(String(filePathValue || ""));
    if (path.dirname(filePath) !== path.dirname(candidatePath) || path.basename(filePath) !== expectedName) {
      throw new Error(`${label} path is outside the protected editor stage`);
    }
    assertProtectedFile(filePath, protectedFileOptions);
    return filePath;
  };
  const assertEditorAck = ({ ackPath, lease, nowMs }) => {
    const artifact = readJsonArtifact(ackPath, "Editor acknowledgement");
    const ack = artifact.value;
    const allowedKeys = new Set(["deploymentId", "contractSha256", "leaseTokenSha256", "sourceCanonicalSha256", "candidateCanonicalSha256", "deployMode", "pausedInjectIds", "requestedAt", "ackAt", "authenticated", "status", "conflict", "preRevisionSha256", "postRevisionSha256"]);
    if (!ack || typeof ack !== "object" || Array.isArray(ack) || Object.keys(ack).some((key) => !allowedKeys.has(key)) || Object.keys(ack).length !== allowedKeys.size) {
      throw new Error("Editor acknowledgement key set mismatch");
    }
    const expected = {
      deploymentId: lease.deploymentId,
      contractSha256: sha256(fs.readFileSync(lease.contractBackup)),
      leaseTokenSha256: leaseTokenSha256(lease),
      sourceCanonicalSha256: lease.sourceCanonicalSha256,
      candidateCanonicalSha256: lease.candidateCanonicalSha256,
      deployMode: "modified-nodes",
      pausedInjectIds: ["e75785ffa19c2e20", "c1ecd06ce451751b"],
      authenticated: true,
      status: "SUCCESS",
      conflict: false,
    };
    for (const [key, value] of Object.entries(expected)) {
      if (JSON.stringify(ack?.[key]) !== JSON.stringify(value)) throw new Error(`Editor acknowledgement binding mismatch: ${key}`);
    }
    const requestedAtMs = Date.parse(ack.requestedAt);
    const ackAtMs = Date.parse(ack.ackAt);
    if (!Number.isFinite(requestedAtMs) || !Number.isFinite(ackAtMs)
      || !/^[a-f0-9]{64}$/.test(String(ack.preRevisionSha256 || ""))
      || !/^[a-f0-9]{64}$/.test(String(ack.postRevisionSha256 || ""))
      || ack.preRevisionSha256 === ack.postRevisionSha256
      || lease.acquiredAtMs > requestedAtMs || requestedAtMs > ackAtMs || ackAtMs > nowMs || nowMs > lease.expiresAtMs) {
      throw new Error("Editor acknowledgement timing or revision binding mismatch");
    }
    return { ...artifact, ack, requestedAtMs, ackAtMs };
  };

  const reserveEditorModified = (options) => {
    const stamp = safeTimestamp(options.stamp);
    assertDeploymentLeaseAvailable();
    const prepared = readEditorPrepared(options);
    const processInfo = pm2.assertOnline();
    ensureBackupDirectory();
    const sourceBackup = path.join(backupDirectory, `editor-source-${prepared.contract.deploymentId}-${stamp}.json`);
    const contractBackup = path.join(backupDirectory, `editor-contract-${prepared.contract.deploymentId}-${stamp}.json`);
    const candidateBackup = path.join(backupDirectory, `editor-candidate-${prepared.contract.deploymentId}-${stamp}.json`);
    const reserveReceipt = editorReceiptPath("reserve", prepared.contract.deploymentId, stamp);
    // Every evidence artifact is durable before the exclusive lease publication.
    writeFileExclusiveDurable(sourceBackup, prepared.liveBytes, protectedFileOptions);
    writeFileExclusiveDurable(contractBackup, prepared.contractBytes, protectedFileOptions);
    writeFileExclusiveDurable(candidateBackup, prepared.candidateBytes, protectedFileOptions);
    const reserve = {
      formatVersion: 1, action: "reserve-editor-modified", deploymentId: prepared.contract.deploymentId,
      sourceSha256: prepared.contract.sourceSha256, candidateSha256: prepared.contract.candidateSha256,
      sourceCanonicalSha256: prepared.contract.sourceCanonicalSha256,
      candidateCanonicalSha256: prepared.contract.candidateCanonicalSha256,
      sourceBackup, contractBackup, candidateBackup, nodeRedPid: processInfo.pid,
      nodeRedRestartCount: processInfo.restartCount, createdAt: new Date(now()).toISOString(),
    };
    writeFileExclusiveDurable(reserveReceipt, Buffer.from(`${JSON.stringify(reserve, null, 2)}\n`, "utf8"), protectedFileOptions);
    if (sha256(fs.readFileSync(liveFlowPath)) !== prepared.contract.sourceSha256
      || canonicalFlowSha256(JSON.parse(fs.readFileSync(liveFlowPath, "utf8"))) !== prepared.contract.sourceCanonicalSha256) {
      throw new Error("Live graph drifted before editor lease publication");
    }
    const freshProcess = pm2.assertOnline();
    if (freshProcess.pid !== processInfo.pid || freshProcess.restartCount !== processInfo.restartCount) throw new Error("Node-RED identity drifted before editor lease publication");
    const acquiredAtMs = now();
    const lease = {
      formatVersion: EDITOR_DEPLOYMENT_LEASE_FORMAT_VERSION, kind: EDITOR_DEPLOYMENT_LEASE_KIND,
      deploymentId: prepared.contract.deploymentId, token: randomUUID(), phase: "editor-reserved",
      acquiredAtMs, expiresAtMs: acquiredAtMs + deploymentLeaseMs,
      sourceSha256: prepared.contract.sourceSha256, candidateSha256: prepared.contract.candidateSha256,
      sourceCanonicalSha256: prepared.contract.sourceCanonicalSha256, candidateCanonicalSha256: prepared.contract.candidateCanonicalSha256,
      nodeRedPid: processInfo.pid, nodeRedRestartCount: processInfo.restartCount,
      sourceBackup, contractBackup, candidateBackup, reserveReceipt, editorStageDirectory: path.dirname(prepared.candidatePath),
    };
    writeFileExclusiveAtomicDurable(deploymentLeasePath, Buffer.from(`${JSON.stringify(lease, null, 2)}\n`, "utf8"), protectedFileOptions);
    const postPublication = pm2.assertOnline();
    const postPublicationBytes = fs.readFileSync(liveFlowPath);
    if (sha256(postPublicationBytes) !== lease.sourceSha256
      || canonicalFlowSha256(JSON.parse(postPublicationBytes.toString("utf8"))) !== lease.sourceCanonicalSha256
      || postPublication.pid !== lease.nodeRedPid
      || postPublication.restartCount !== lease.nodeRedRestartCount) {
      writeEditorLease({ ...lease, phase: "editor-owner-decision" });
      throw new Error("Editor reservation drifted after lease publication; lease retained for OWNER_DECISION");
    }
    return { ok: true, action: "reserve-editor-modified", deploymentId: lease.deploymentId, leaseToken: lease.token,
      reserveReceipt, sourceBackup, contractBackup, candidateBackup, nodeRedPid: processInfo.pid,
      nodeRedRestartCount: processInfo.restartCount, liveFlowWritten: false, nodeRedRestarted: false };
  };

  const confirmEditorModified = (options) => {
    const lease = assertEditorLease(options, new Set(["editor-reserved", "editor-soaking"]));
    if (lease.phase === "editor-reserved" && now() > lease.expiresAtMs) {
      writeEditorLease({ ...lease, phase: "editor-owner-decision" });
      throw new Error("Editor confirmation deadline expired; lease retained for OWNER_DECISION");
    }
    const activeBytes = fs.readFileSync(liveFlowPath);
    const candidateBytes = fs.readFileSync(lease.candidateBackup);
    const sourceBytes = fs.readFileSync(lease.sourceBackup);
    const activeRaw = sha256(activeBytes);
    if (activeRaw === lease.sourceSha256) throw new Error("Editor acknowledgement is absent: source graph remains active; UI must not be replayed automatically");
    if (canonicalFlowSha256(JSON.parse(activeBytes.toString("utf8"))) !== lease.candidateCanonicalSha256) {
      throw new Error("Editor-modified graph is unknown or differs from the exact candidate; lease retained for owner decision");
    }
    validateEditorPauseInjectsContract({ liveBytes: sourceBytes, candidateBytes, contract: JSON.parse(fs.readFileSync(lease.contractBackup, "utf8")) });
    const processInfo = assertEditorRuntime(lease);
    const ackPath = assertEditorStageArtifact(options.editorAckPath, path.join(lease.editorStageDirectory, "candidate.flow.json"), "editor-ack.json", "Editor acknowledgement");
    const acknowledgement = assertEditorAck({ ackPath, lease, nowMs: now() });
    if (lease.phase === "editor-soaking") {
      if (!lease.confirmReceipt) throw new Error("Editor soak lease has no confirmation receipt");
      const receipt = readJsonArtifact(lease.confirmReceipt, "Editor confirmation receipt").value;
      if (receipt.ackSha256 !== acknowledgement.sha256 || receipt.observedRawSha256 !== activeRaw
        || receipt.candidateCanonicalSha256 !== lease.candidateCanonicalSha256
        || receipt.postRevisionSha256 !== acknowledgement.ack.postRevisionSha256) {
        throw new Error("Editor confirmation receipt does not bind the current acknowledgement");
      }
      return { ok: true, action: "confirm-editor-modified", resumed: true, deploymentId: lease.deploymentId, nodeRedPid: processInfo.pid, nodeRedRestartCount: processInfo.restartCount, liveFlowWritten: false, nodeRedRestarted: false };
    }
    const receiptPath = editorReceiptPath("confirm", lease.deploymentId, safeTimestamp(options.stamp));
    const receipt = { formatVersion: 1, action: "confirm-editor-modified", deploymentId: lease.deploymentId,
      ackPath, ackSha256: acknowledgement.sha256, sourceSha256: lease.sourceSha256, candidateSha256: lease.candidateSha256,
      observedRawSha256: activeRaw, candidateCanonicalSha256: lease.candidateCanonicalSha256,
      postRevisionSha256: acknowledgement.ack.postRevisionSha256, nodeRedPid: processInfo.pid, nodeRedRestartCount: processInfo.restartCount, confirmedAt: new Date(now()).toISOString() };
    if (fs.existsSync(receiptPath)) {
      assertProtectedFile(receiptPath, protectedFileOptions);
      const existing = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
      for (const key of ["formatVersion", "action", "deploymentId", "ackPath", "ackSha256", "sourceSha256", "candidateSha256", "observedRawSha256", "candidateCanonicalSha256", "postRevisionSha256", "nodeRedPid", "nodeRedRestartCount"]) {
        if (existing[key] !== receipt[key]) throw new Error("Editor confirmation receipt mismatch; lease retained for owner decision");
      }
    } else writeFileExclusiveDurable(receiptPath, Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8"), protectedFileOptions);
    const refreshed = writeEditorLease({ ...lease, phase: "editor-soaking", acquiredAtMs: now(), expiresAtMs: now() + EDITOR_SOAK_MS, confirmReceipt: receiptPath, observedRawSha256: activeRaw, ackSha256: acknowledgement.sha256, postRevisionSha256: acknowledgement.ack.postRevisionSha256 });
    return { ok: true, action: "confirm-editor-modified", deploymentId: refreshed.deploymentId, confirmReceipt: receiptPath, soakSeconds: EDITOR_SOAK_MS / 1000, nodeRedPid: processInfo.pid, nodeRedRestartCount: processInfo.restartCount, liveFlowWritten: false, nodeRedRestarted: false };
  };

  const finishEditorModified = (options) => {
    const stamp = safeTimestamp(options.stamp);
    const successPath = editorReceiptPath("finish", safeDeploymentId(options.deploymentId), stamp);
    if (!fs.existsSync(deploymentLeasePath) && fs.existsSync(successPath)) {
      assertProtectedFile(successPath, protectedFileOptions);
      const receipt = JSON.parse(fs.readFileSync(successPath, "utf8"));
      if (receipt?.action !== "finish-editor-modified" || receipt?.deploymentId !== safeDeploymentId(options.deploymentId)
        || readJsonArtifact(options.observationPath, "Operator observation").sha256 !== receipt.observationSha256
        || sha256(fs.readFileSync(liveFlowPath)) !== receipt.observedRawSha256) {
        throw new Error("Editor finish receipt no longer matches the live graph");
      }
      const processInfo = pm2.assertOnline();
      if (processInfo.pid !== receipt.nodeRedPid || processInfo.restartCount !== receipt.nodeRedRestartCount) throw new Error("Editor finish receipt no longer matches Node-RED identity");
      return { ok: true, action: "finish-editor-modified", deploymentId: receipt.deploymentId, receiptPath: successPath, resumed: true, liveFlowWritten: false, nodeRedRestarted: false };
    }
    const lease = assertEditorLease(options, new Set(["editor-soaking"]));
    if (now() < lease.acquiredAtMs + EDITOR_SOAK_MS) throw new Error("Editor-modified soak window is incomplete");
    const observationPath = assertEditorStageArtifact(options.observationPath, path.join(lease.editorStageDirectory, "candidate.flow.json"), "editor-observation.json", "Operator observation");
    const observation = readJsonArtifact(observationPath, "Operator observation");
    const observationAtMs = Date.parse(observation.value?.observedAt);
    const confirmReceiptSha256 = sha256(fs.readFileSync(lease.confirmReceipt || ""));
    if (!Number.isFinite(observationAtMs) || observationAtMs < lease.acquiredAtMs + EDITOR_SOAK_MS
      || observation.value?.confirmReceiptSha256 !== confirmReceiptSha256
      || observation.value?.postRevisionSha256 !== lease.postRevisionSha256
      || observation.value?.candidateCanonicalSha256 !== lease.candidateCanonicalSha256
      || observation.value?.nodeRedPid !== lease.nodeRedPid
      || observation.value?.nodeRedRestartCount !== lease.nodeRedRestartCount) {
      throw new Error("Operator observation binding mismatch");
    }
    const activeBytes = fs.readFileSync(liveFlowPath);
    if (sha256(activeBytes) !== lease.observedRawSha256 || canonicalFlowSha256(JSON.parse(activeBytes.toString("utf8"))) !== lease.candidateCanonicalSha256) throw new Error("Editor-modified graph drift; lease retained for owner decision");
    const processInfo = assertEditorRuntime(lease);
    const receipt = { formatVersion: 1, action: "finish-editor-modified", deploymentId: lease.deploymentId,
      observationPath, observationSha256: observation.sha256, candidateSha256: lease.candidateSha256, observedRawSha256: lease.observedRawSha256, nodeRedPid: processInfo.pid,
      nodeRedRestartCount: processInfo.restartCount, verifiedAt: new Date(now()).toISOString() };
    if (fs.existsSync(successPath)) {
      assertProtectedFile(successPath, protectedFileOptions);
      const existing = JSON.parse(fs.readFileSync(successPath, "utf8"));
      for (const key of ["formatVersion", "action", "deploymentId", "observationPath", "observationSha256", "candidateSha256", "observedRawSha256", "nodeRedPid", "nodeRedRestartCount"]) {
        if (existing[key] !== receipt[key]) throw new Error("Editor finish receipt mismatch; lease retained for owner decision");
      }
    } else writeFileExclusiveDurable(successPath, Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8"), protectedFileOptions);
    releaseDeploymentLease(lease);
    return { ok: true, action: "finish-editor-modified", deploymentId: lease.deploymentId, receiptPath: successPath, nodeRedPid: processInfo.pid, nodeRedRestartCount: processInfo.restartCount, deploymentLeaseReleased: true, liveFlowWritten: false, nodeRedRestarted: false };
  };

  const abortEditorModified = (options) => {
    const stamp = safeTimestamp(options.stamp);
    const deploymentId = safeDeploymentId(options.deploymentId);
    const receiptPath = editorReceiptPath("abort", deploymentId, stamp);
    if (!fs.existsSync(deploymentLeasePath) && fs.existsSync(receiptPath)) {
      const receipt = readJsonArtifact(receiptPath, "Editor abort receipt").value;
      const activeBytes = fs.readFileSync(liveFlowPath);
      const processInfo = pm2.assertOnline();
      if (receipt?.action !== "abort-editor-modified" || receipt.deploymentId !== deploymentId
        || receipt.leaseTokenSha256 !== sha256(Buffer.from(String(options.leaseToken || ""), "utf8"))
        || sha256(activeBytes) !== receipt.sourceSha256
        || canonicalFlowSha256(JSON.parse(activeBytes.toString("utf8"))) !== receipt.sourceCanonicalSha256
        || processInfo.pid !== receipt.nodeRedPid || processInfo.restartCount !== receipt.nodeRedRestartCount) {
        throw new Error("Editor abort receipt no longer matches source state");
      }
      return { ok: true, action: "abort-editor-modified", deploymentId, receiptPath, resumed: true, deploymentLeaseReleased: true, liveFlowWritten: false, nodeRedRestarted: false };
    }
    const lease = assertEditorLease(options, new Set(["editor-reserved", "editor-owner-decision"]));
    const activeBytes = fs.readFileSync(liveFlowPath);
    if (sha256(activeBytes) !== lease.sourceSha256 || canonicalFlowSha256(JSON.parse(activeBytes.toString("utf8"))) !== lease.sourceCanonicalSha256) {
      writeEditorLease({ ...lease, phase: "editor-owner-decision" });
      throw new Error("Editor UI effect or graph drift detected; lease retained for OWNER_DECISION");
    }
    const processInfo = assertEditorRuntime(lease);
    const leaseSha256 = sha256(fs.readFileSync(deploymentLeasePath));
    const receipt = { formatVersion: 1, action: "abort-editor-modified", deploymentId: lease.deploymentId,
      sourceSha256: lease.sourceSha256, sourceCanonicalSha256: lease.sourceCanonicalSha256,
      leaseTokenSha256: leaseTokenSha256(lease), leaseSha256, nodeRedPid: processInfo.pid, nodeRedRestartCount: processInfo.restartCount };
    if (fs.existsSync(receiptPath)) {
      const existing = readJsonArtifact(receiptPath, "Editor abort receipt").value;
      for (const [key, value] of Object.entries(receipt)) if (existing[key] !== value) throw new Error("Editor abort receipt mismatch; lease retained for owner decision");
    } else writeFileExclusiveDurable(receiptPath, Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8"), protectedFileOptions);
    const finalBytes = fs.readFileSync(liveFlowPath);
    const finalProcess = assertEditorRuntime(lease);
    if (sha256(finalBytes) !== lease.sourceSha256 || canonicalFlowSha256(JSON.parse(finalBytes.toString("utf8"))) !== lease.sourceCanonicalSha256
      || finalProcess.pid !== processInfo.pid || finalProcess.restartCount !== processInfo.restartCount
      || sha256(fs.readFileSync(deploymentLeasePath)) !== leaseSha256) throw new Error("Editor abort state changed before release; lease retained for OWNER_DECISION");
    releaseDeploymentLease(lease);
    return { ok: true, action: "abort-editor-modified", deploymentId: lease.deploymentId, receiptPath, deploymentLeaseReleased: true, liveFlowWritten: false, nodeRedRestarted: false };
  };

  return { preflight, apply, rollback, reconcileCurrent, finalizeLegacyCandidate, reserveEditorModified, confirmEditorModified, finishEditorModified, abortEditorModified };
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
        : action === "reconcile-current"
          ? runtime.reconcileCurrent({
            deploymentId: common.deploymentId,
            stamp: getArg("--stamp"),
            flowBackup: getArg("--flow-backup"),
            contractBackup: getArg("--contract-backup"),
            candidateBackup: getArg("--candidate-backup"),
          })
        : action === "finalize-legacy-v1-candidate"
          ? runtime.finalizeLegacyCandidate({
            deploymentId: common.deploymentId,
            stamp: getArg("--stamp"),
            flowBackup: getArg("--flow-backup"),
            contractBackup: getArg("--contract-backup"),
            expectedLeaseSha256: getArg("--expected-lease-sha256"),
            expectedActiveSha256: getArg("--expected-active-sha256"),
            expectedFlowBackupSha256: getArg("--expected-flow-backup-sha256"),
            expectedContractBackupSha256: getArg("--expected-contract-backup-sha256"),
          })
        : action === "reserve-editor-modified"
          ? runtime.reserveEditorModified({ ...common, stamp: getArg("--stamp") })
          : action === "confirm-editor-modified"
            ? runtime.confirmEditorModified({
              deploymentId: common.deploymentId, leaseToken: getArg("--lease-token"),
              stamp: getArg("--stamp"), editorAckPath: getArg("--editor-ack"),
            })
            : action === "finish-editor-modified"
              ? runtime.finishEditorModified({
                deploymentId: common.deploymentId, leaseToken: getArg("--lease-token"),
                stamp: getArg("--stamp"), observationPath: getArg("--observation"),
              })
              : action === "abort-editor-modified"
                ? runtime.abortEditorModified({
                  deploymentId: common.deploymentId, leaseToken: getArg("--lease-token"), stamp: getArg("--stamp"),
                })
        : null;
  if (!result) {
    throw new Error(
      "Usage: deploy_reviewed_flow_147_remote.mjs <preflight|apply|rollback|reconcile-current|finalize-legacy-v1-candidate|reserve-editor-modified|confirm-editor-modified|finish-editor-modified|abort-editor-modified> [options]",
    );
  }
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
