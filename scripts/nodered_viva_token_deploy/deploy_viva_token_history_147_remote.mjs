#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  REVIEWED_LIVE_FLOW_SHA256,
  buildManagedEnvironment,
  sha256,
  validateDeploymentCandidate,
  validateManagedEnvironment,
} from "./runtime_contract.mjs";

const LIVE_FLOW_PATH = "/root/.node-red/flows.json";
const MANAGED_ENV_PATH = "/root/.node-red/.padlhub-viva-service.json";
const PM2_DUMP_PATH = "/root/.pm2/dump.pm2";
const BACKUP_DIRECTORY = "/root/.node-red/.padlhub-viva-token-history-backups";
const MANAGED_KEYS = [
  "VIVA_SERVICE_USERNAME",
  "VIVA_SERVICE_PASSWORD",
  "VIVA_SERVICE_CLIENT_ID",
  "VIVA_SERVICE_TOKEN_URL",
];

const exactFile = (filePath, mode = 0o600) => {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || stat.gid !== 0) {
    throw new Error(`Protected runtime path contract mismatch: ${filePath}`);
  }
  if ((stat.mode & 0o777) !== mode) {
    throw new Error(`Protected runtime path mode mismatch: ${filePath}`);
  }
};

const atomicWrite = (destination, bytes) => {
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
    fs.chownSync(temporary, 0, 0);
    fs.renameSync(temporary, destination);
    fs.chmodSync(destination, 0o600);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* best-effort cleanup after atomic rename */ }
  }
};

const safeTimestamp = (value) => {
  if (!/^\d{8}T\d{6}[+-]\d{4}$/.test(String(value || ""))) {
    throw new Error("Backup timestamp must use YYYYMMDDTHHMMSS+ZZZZ");
  }
  return value;
};

const runPm2 = (args, managed = null) => {
  const environment = { ...process.env };
  if (managed) Object.assign(environment, managed);
  const result = spawnSync("pm2", args, {
    encoding: "utf8",
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`PM2 command failed: pm2 ${args.join(" ")}`);
  }
  return result.stdout;
};

const getNodeRedProcess = () => {
  const processes = JSON.parse(runPm2(["jlist"]));
  const matches = processes.filter((item) => item?.name === "node-red");
  if (matches.length !== 1) throw new Error("Expected exactly one PM2 node-red process");
  return matches[0];
};

const assertNodeRedOnline = (managed = null) => {
  const processInfo = getNodeRedProcess();
  if (processInfo?.pm2_env?.status !== "online") {
    throw new Error("PM2 node-red process is not online");
  }
  if (managed) {
    for (const key of MANAGED_KEYS) {
      if (processInfo?.pm2_env?.[key] !== managed[key]) {
        throw new Error(`PM2 managed environment mismatch: ${key}`);
      }
    }
  }
  return { pid: Number(processInfo.pid), restartCount: Number(processInfo?.pm2_env?.restart_time) };
};

const restartWithManagedEnvironment = (managed) => {
  runPm2(["restart", "node-red", "--update-env"], managed);
  const processInfo = assertNodeRedOnline(managed);
  runPm2(["save"]);
  return processInfo;
};

const readLiveFlow = () => {
  exactFile(LIVE_FLOW_PATH);
  const bytes = fs.readFileSync(LIVE_FLOW_PATH);
  const digest = sha256(bytes);
  if (digest !== REVIEWED_LIVE_FLOW_SHA256) {
    throw new Error(`Live flow preimage mismatch: expected ${REVIEWED_LIVE_FLOW_SHA256}, got ${digest}`);
  }
  const flow = JSON.parse(bytes.toString("utf8"));
  if (!Array.isArray(flow)) throw new Error("Live flow must be a JSON array");
  return { bytes, flow, digest };
};

const readManagedEnvironment = () => {
  exactFile(MANAGED_ENV_PATH);
  return validateManagedEnvironment(JSON.parse(fs.readFileSync(MANAGED_ENV_PATH, "utf8")));
};

const ensureBackupDirectory = () => {
  if (!fs.existsSync(BACKUP_DIRECTORY)) {
    fs.mkdirSync(BACKUP_DIRECTORY, { mode: 0o700 });
    fs.chownSync(BACKUP_DIRECTORY, 0, 0);
  }
  const stat = fs.lstatSync(BACKUP_DIRECTORY);
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || stat.uid !== 0
    || stat.gid !== 0
    || (stat.mode & 0o777) !== 0o700
  ) throw new Error("Protected backup directory contract mismatch");
};

const backupPm2Dump = (stamp, purpose) => {
  if (!fs.existsSync(PM2_DUMP_PATH)) throw new Error("PM2 dump is absent");
  exactFile(PM2_DUMP_PATH);
  ensureBackupDirectory();
  if (!/^[a-z-]+$/.test(purpose)) throw new Error("PM2 backup purpose is invalid");
  const destination = path.join(BACKUP_DIRECTORY, `dump-pre-${purpose}-${stamp}.pm2`);
  fs.copyFileSync(PM2_DUMP_PATH, destination, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(destination, 0o600);
  fs.chownSync(destination, 0, 0);
  return destination;
};

export const installManagedEnvironment = (stampValue) => {
  if (process.getuid?.() !== 0) throw new Error("Remote installer must run as root");
  const stamp = safeTimestamp(stampValue);
  const live = readLiveFlow();
  const environmentDocument = buildManagedEnvironment(live.flow);
  const managed = validateManagedEnvironment(environmentDocument);
  const pm2DumpBackup = backupPm2Dump(stamp, "viva-service");
  let created = false;
  if (fs.existsSync(MANAGED_ENV_PATH)) {
    exactFile(MANAGED_ENV_PATH);
    const existing = JSON.parse(fs.readFileSync(MANAGED_ENV_PATH, "utf8"));
    if (!isDeepStrictEqual(existing, environmentDocument)) {
      throw new Error("Existing managed Viva environment does not match reviewed live credentials");
    }
  } else {
    atomicWrite(MANAGED_ENV_PATH, `${JSON.stringify(environmentDocument, null, 2)}\n`);
    created = true;
  }
  const processInfo = restartWithManagedEnvironment(managed);
  if (sha256(fs.readFileSync(LIVE_FLOW_PATH)) !== live.digest) {
    throw new Error("Flow changed while installing the managed environment");
  }
  return {
    ok: true,
    action: "install-env",
    created,
    liveFlowSha256: live.digest,
    managedEnvironmentPath: MANAGED_ENV_PATH,
    managedEnvironmentMode: "0600",
    pm2DumpBackup,
    nodeRedOnline: true,
    nodeRedPid: processInfo.pid,
    nodeRedRestartCount: processInfo.restartCount,
  };
};

export const applyCandidateFlow = (candidatePathValue, stampValue) => {
  if (process.getuid?.() !== 0) throw new Error("Remote installer must run as root");
  const stamp = safeTimestamp(stampValue);
  const candidatePath = path.resolve(String(candidatePathValue || ""));
  exactFile(candidatePath);
  const live = readLiveFlow();
  const managed = readManagedEnvironment();
  const expectedManaged = validateManagedEnvironment(buildManagedEnvironment(live.flow));
  if (!isDeepStrictEqual(managed, expectedManaged)) {
    throw new Error("Managed Viva environment no longer matches reviewed live credentials");
  }
  assertNodeRedOnline(managed);
  const candidateBytes = fs.readFileSync(candidatePath);
  const candidateFlow = JSON.parse(candidateBytes.toString("utf8"));
  const validation = validateDeploymentCandidate(live.flow, candidateFlow);
  const candidateSha256 = sha256(candidateBytes);

  ensureBackupDirectory();
  const flowBackup = path.join(BACKUP_DIRECTORY, `flows-pre-viva-token-history-${stamp}.json`);
  fs.writeFileSync(flowBackup, live.bytes, { flag: "wx", mode: 0o600 });
  fs.chownSync(flowBackup, 0, 0);
  const pm2DumpBackup = backupPm2Dump(stamp, "viva-flow");

  let published = false;
  try {
    atomicWrite(LIVE_FLOW_PATH, candidateBytes);
    published = true;
    const processInfo = restartWithManagedEnvironment(managed);
    const activeSha256 = sha256(fs.readFileSync(LIVE_FLOW_PATH));
    if (activeSha256 !== candidateSha256) throw new Error("Active flow digest differs from candidate");
    return {
      ok: true,
      action: "apply-flow",
      livePreimageSha256: live.digest,
      candidateSha256,
      activeFlowSha256: activeSha256,
      flowBackup,
      pm2DumpBackup,
      nodeRedOnline: true,
      nodeRedPid: processInfo.pid,
      nodeRedRestartCount: processInfo.restartCount,
      validation,
    };
  } catch (error) {
    if (published) {
      atomicWrite(LIVE_FLOW_PATH, live.bytes);
      try {
        restartWithManagedEnvironment(managed);
      } catch {
        throw new Error("Candidate failed; reviewed flow bytes were restored but Node-RED rollback restart failed");
      }
      if (sha256(fs.readFileSync(LIVE_FLOW_PATH)) !== live.digest) {
        throw new Error("Candidate failed and automatic flow rollback did not restore the reviewed digest");
      }
    }
    throw new Error(`Candidate deployment failed; reviewed flow rollback completed: ${error.message}`);
  }
};

export const rollbackCandidateFlow = (backupPathValue, expectedCandidateSha256) => {
  if (process.getuid?.() !== 0) throw new Error("Remote rollback must run as root");
  const backupPath = path.resolve(String(backupPathValue || ""));
  if (
    path.dirname(backupPath) !== BACKUP_DIRECTORY
    || !/^flows-pre-viva-token-history-\d{8}T\d{6}[+-]\d{4}\.json$/.test(path.basename(backupPath))
  ) throw new Error("Rollback backup path is outside the managed contract");
  if (!/^[a-f0-9]{64}$/.test(String(expectedCandidateSha256 || ""))) {
    throw new Error("Expected candidate digest is invalid");
  }
  exactFile(LIVE_FLOW_PATH);
  exactFile(backupPath);
  const activeSha256 = sha256(fs.readFileSync(LIVE_FLOW_PATH));
  if (activeSha256 !== expectedCandidateSha256) {
    throw new Error("Active flow no longer matches the candidate selected for rollback");
  }
  const backupBytes = fs.readFileSync(backupPath);
  if (sha256(backupBytes) !== REVIEWED_LIVE_FLOW_SHA256) {
    throw new Error("Rollback backup does not match the reviewed live flow");
  }
  const managed = readManagedEnvironment();
  atomicWrite(LIVE_FLOW_PATH, backupBytes);
  const processInfo = restartWithManagedEnvironment(managed);
  const restoredSha256 = sha256(fs.readFileSync(LIVE_FLOW_PATH));
  if (restoredSha256 !== REVIEWED_LIVE_FLOW_SHA256) {
    throw new Error("Explicit rollback did not restore the reviewed flow digest");
  }
  return {
    ok: true,
    action: "rollback-flow",
    rolledBackFromSha256: activeSha256,
    restoredFlowSha256: restoredSha256,
    flowBackup: backupPath,
    nodeRedOnline: true,
    nodeRedPid: processInfo.pid,
    nodeRedRestartCount: processInfo.restartCount,
  };
};

const getArg = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};

export const main = () => {
  const action = process.argv[2];
  const stamp = getArg("--stamp");
  const result = action === "install-env"
    ? installManagedEnvironment(stamp)
    : action === "apply-flow"
      ? applyCandidateFlow(getArg("--candidate"), stamp)
      : action === "rollback-flow"
        ? rollbackCandidateFlow(getArg("--backup"), getArg("--expected-candidate-sha256"))
      : null;
  if (!result) throw new Error("Usage: deploy_viva_token_history_147_remote.mjs <install-env|apply-flow|rollback-flow> [action options]");
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
