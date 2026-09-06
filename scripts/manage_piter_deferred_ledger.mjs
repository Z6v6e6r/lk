#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  sha256,
  stableJson,
  validatePiterDeferredActivationPacket,
  assertFreshDeferredActivationRecheck,
} from "./lib/piterDeferredActivationContract.mjs";
import { readPrivateDeferredJson } from './prepare_piter_deferred_activation.mjs';
import { createPm2Adapter } from './nodered_reviewed_flow_deploy/deploy_reviewed_flow_147_remote.mjs';
import {
  buildPiterDeferredLedgerPlan,
  redactPiterDeferredLedgerPlan,
  validateAtomicLedgerCustody,
  validateAtomicLedgerShape,
} from "./lib/piterDeferredLedgerOperations.mjs";

const LIVE_FLOW_PATH = "/root/.node-red/flows.json";
const DEPLOYMENT_LOCK_PATH = "/root/.node-red/.padlhub-reviewed-flow-deploy.lock";
const DEPLOYMENT_LEASE_PATH = "/root/.node-red/.padlhub-reviewed-flow-deploy.lease.json";
const DEPLOYMENT_LOCK_WRAPPED_ENV = "PADLHUB_REVIEWED_FLOW_LOCK_WRAPPED";
const TARGET_HOST = "lk-primary-147";
const MAX_MONGO_TIME_MS = 5_000;
const PUBLICATION_PATH = '/root/.node-red/.padlhub-piter-only-release.json';
const START_GRANT_PATH = '/root/.node-red/.padlhub-piter-only-start-grant.json';
const START_INTENT_PATH = '/root/.node-red/.padlhub-piter-only-start-consumed.json';
const START_RESULT_PATH = '/root/.node-red/.padlhub-piter-only-start-result.json';
const QUIESCENCE_PROOF_PATH = '/root/.node-red/.padlhub-piter-only-quiescence.json';
const START_COMMAND_TIMEOUT_MS = 2_000;
const START_REQUIRED_BUDGET_MS = 9_000; // command + inspection/custody budget; not a daemon guarantee
const PUBLICATION_SCRIPTS = Object.freeze([
  'manage_piter_deferred_ledger.mjs','prepare_piter_deferred_activation.mjs',
  'lib/piterDeferredActivationContract.mjs','lib/piterDeferredLedgerOperations.mjs',
  'lib/piterAtomicActivationContract.mjs','lib/piterAtomicLedgerOperations.mjs','lib/piterAtomicQuotaUpdateContract.mjs',
  'nodered_reviewed_flow_deploy/deploy_reviewed_flow_147_remote.mjs','nodered_reviewed_flow_deploy/runtime_contract.mjs',
]);

const usage = `
manage_piter_deferred_ledger

Fail-closed operator for the Piter atomic inventory sentinel. Dry-run is the
default and consumes a complete read-only Mongo snapshot. Live mutation is
possible only on lk-primary-147 while holding the reviewed-flow deployment
lock, reading the canonical root-owned flow, verifying the Mongo identity,
and passing exact contract/revision/action gates. Credentials stay in env.

Dry-run:
  node scripts/manage_piter_deferred_ledger.mjs \
    --action preflight|seed|activate|deactivate|rollback-check \
    --packet /absolute/private/activation.packet.json \
    --ledger-file /absolute/private/current-ledger-evidence.json \
    [--active-flow /absolute/current/flows.json] \
    [--expected-revision N] [--reason "operator reason"]

Live apply (future separately authorized operation only):
  LK_PITER_DEFERRED_TARGET=lk-primary-147 \
  LK_PITER_DEFERRED_EXPECTED_HOST_IDENTITY_SHA256=<sha256> \
  LK_PITER_DEFERRED_MONGO_URI=... \
  LK_PITER_DEFERRED_EXPECTED_MONGO_IDENTITY_SHA256=<sha256> \
  LK_PITER_DEFERRED_LEDGER_ACTION=DEFERRED_SEED_147|DEFERRED_ACTIVATE_147|DEFERRED_DEACTIVATE_147 \
  node scripts/manage_piter_deferred_ledger.mjs ... --apply \
    --active-flow /root/.node-red/flows.json \
    --expected-contract-digest <sha256> --backup-dir /absolute/new/private/dir

Optional future process control: --guarded-start ONLY with --apply --action activate,
plus LK_PITER_DEFERRED_START_ACTION=DEFERRED_START_PITER_ONLY_147 and separately
issued fixed private start grant/quiescence evidence. Disabled by default.
This option can make sales reachable; source/tests are not live authorization.
`;

const VALUE_FLAGS = new Map([
  ["--action", "action"],
  ["--packet", "packetFile"],
  ["--ledger-file", "ledgerFile"],
  ["--active-flow", "activeFlowFile"],
  ["--expected-revision", "expectedRevision"],
  ["--expected-contract-digest", "expectedContractDigest"],
  ["--backup-dir", "backupDir"],
  ["--reason", "reason"],
  ["--activation-recheck-file", "activationRecheckFile"],
]);

const APPLY_GATES = Object.freeze({
  seed: "DEFERRED_SEED_147",
  activate: "DEFERRED_ACTIVATE_147",
  deactivate: "DEFERRED_DEACTIVATE_147",
});

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const toStr = (value) => value == null ? null : (String(value).trim() || null);
const freshNow = (nowFn) => {
  const value = nowFn();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("operator clock is invalid");
  return date;
};

export function parseArgs(argv) {
  const options = { apply: false, help: false };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") { options.help = true; continue; }
    if (arg === "--apply") { options.apply = true; continue; }
    if (arg === '--guarded-start') {
      if (options.guardedStart) throw new Error('duplicate --guarded-start');
      options.guardedStart = true; continue;
    }
    const key = VALUE_FLAGS.get(arg);
    if (!key) throw new Error(`Unsupported option: ${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
    if (seen.has(key)) throw new Error(`${arg} may be provided only once`);
    seen.add(key);
    options[key] = value;
    index += 1;
  }
  if (options.help) return options;
  options.action = toStr(options.action);
  options.packetFile = toStr(options.packetFile);
  if (!options.action || !options.packetFile) throw new Error("--action and --packet are required");
  if (!["preflight", "seed", "activate", "deactivate", "rollback-check"].includes(options.action)) {
    throw new Error("--action is unsupported");
  }
  for (const key of ["packetFile", "ledgerFile", "activeFlowFile", "backupDir", "activationRecheckFile"]) {
    if (options[key] && !path.isAbsolute(options[key])) throw new Error(`${key} must be an absolute path`);
  }
  if (["seed", "activate", "deactivate"].includes(options.action) && options.expectedRevision === undefined) {
    throw new Error(`${options.action} requires --expected-revision`);
  }
  const revision = Number(options.expectedRevision ?? 0);
  if (!Number.isInteger(revision) || revision < 0) throw new Error("--expected-revision must be a non-negative integer");
  options.expectedRevision = revision;
  if (!options.apply && !options.ledgerFile) throw new Error("dry-run requires --ledger-file");
  if (options.apply && options.ledgerFile) throw new Error("--ledger-file is forbidden with --apply; live state must be read after connecting");
  if ((["preflight", "seed", "activate"].includes(options.action) || options.apply) && !options.activeFlowFile) {
    throw new Error(`${options.action} requires --active-flow`);
  }
  if (options.apply && !APPLY_GATES[options.action]) throw new Error(`${options.action} is read-only and does not support --apply`);
  if (options.action === 'activate' && !options.activationRecheckFile) throw new Error('activate requires --activation-recheck-file');
  if (options.guardedStart && (!options.apply || options.action !== 'activate')) throw new Error('guarded start requires mutation-performing apply activate');
  return options;
}

export const deferredStartEnvironment = () => ({
  HOME:'/root', PM2_HOME:'/root/.pm2', PATH:'/usr/local/bin:/usr/bin:/bin', LANG:'C',
});

// Bind only stable process configuration, never export raw PM2 env/secrets.
// Effective userDir/flow resolution is a release-owner prerequisite bound to
// this definition hash; this code never guesses missing PM2 defaults.
export function deferredPm2Identity(processes) {
  if (!Array.isArray(processes)) throw new Error('PM2 inventory unknown');
  const matches=processes.filter(p=>p?.name==='node-red');
  if (matches.length!==1) throw new Error('exactly one named Node-RED process required');
  const p=matches[0], e=p.pm2_env;
  if (!e || !Number.isSafeInteger(p.pm_id) || p.pm_id<0
    || !Number.isSafeInteger(p.pid) || p.pid<0 || !Number.isSafeInteger(e.restart_time) || e.restart_time<0
    || !['stopped','online'].includes(e.status)
    || !['pm_exec_path','pm_cwd','exec_interpreter','exec_mode'].every(k=>typeof e[k]==='string' && e[k].length>0)
    || !path.isAbsolute(e.pm_exec_path) || !path.isAbsolute(e.pm_cwd)) throw new Error('PM2 definition incomplete');
  const definition={name:p.name,id:p.pm_id,executable:e.pm_exec_path,cwd:e.pm_cwd,
    interpreter:e.exec_interpreter,mode:e.exec_mode,args:e.args??[],nodeArgs:e.node_args??[],
    uid:e.uid??null,gid:e.gid??null,instances:e.instances??null,
    lifecycle:Object.fromEntries(['autorestart','watch','ignore_watch','cron_restart','restart_delay',
      'exp_backoff_restart_delay','min_uptime','max_restarts','max_memory_restart','stop_exit_codes',
      'kill_timeout','listen_timeout','wait_ready','shutdown_with_message'].map(k=>[k,e[k]??null])),
    environmentDigest:sha256(stableJson(e.env??{}))};
  return {status:e.status,pid:p.pid,restartCount:e.restart_time,definitionDigest:sha256(stableJson(definition))};
}

const assertOwnedAncestors = (file, uid, fsImpl=fs) => {
  for (let dir=path.dirname(file);;dir=path.dirname(dir)) {
    const s=fsImpl.lstatSync(dir);
    if (!s.isDirectory() || s.isSymbolicLink() || s.uid!==uid || (s.mode&0o022)!==0) throw new Error('installed ancestor custody');
    if (dir===path.dirname(dir)) break;
  }
};

export function publishDeferredStartEvidence(file, payload, uid=0, fsImpl=fs) {
  assertOwnedAncestors(file,uid,fsImpl);
  const parent=fsImpl.lstatSync(path.dirname(file));
  if ((parent.mode&0o077)!==0) throw new Error('start evidence parent must be private');
  // O_EXCL temp and link (never rename-overwrite) make even partial evidence
  // fail closed. Retain both files on any failure; recovery is separately owned.
  const temp=file+'.pending';
  const bytes=Buffer.from(stableJson(payload)+'\n');
  durableWriteExclusive(temp,bytes,fsImpl);
  fsImpl.linkSync(temp,file);
  const fd=fsImpl.openSync(path.dirname(file),'r');
  try { fsImpl.fsyncSync(fd); } finally { fsImpl.closeSync(fd); }
  if (!fsImpl.readFileSync(file).equals(bytes)) throw new Error('start evidence readback mismatch');
  return sha256(bytes);
}

const readStartGrant = uid => {
  assertOwnedAncestors(START_GRANT_PATH,uid);
  return readPrivateDeferredJson(START_GRANT_PATH,uid);
};

// A separately issued release-owner attestation, never generated by this tool.
// Custody/digest validation is not independent proof that every writer is absent.
export function assertDeferredQuiescenceProof(proof, expected, now) {
  const keys=['formatVersion','purpose','createdAt','expiresAt','externalWritersExcluded','writerInventoryDigest',
    'hostIdentitySha256','mongoIdentitySha256','candidateSha256','publicationDigest','leaseDigest',
    'preimageDigest','pm2DefinitionDigest','stoppedRestartCount','effectiveUserDir','effectiveFlowPath'];
  if(!proof || Object.keys(proof).sort().join(',')!==keys.sort().join(','))throw new Error('quiescence proof schema');
  const created=Date.parse(proof.createdAt),expires=Date.parse(proof.expiresAt);
  if(proof.formatVersion!==1 || proof.purpose!=='PITER_ONLY_START_QUIESCENCE' || proof.externalWritersExcluded!==true
    || !SHA256_PATTERN.test(proof.writerInventoryDigest||'') || !Number.isFinite(created)||!Number.isFinite(expires)
    || new Date(created).toISOString()!==proof.createdAt||new Date(expires).toISOString()!==proof.expiresAt
    || created>now.getTime()||expires<=now.getTime()||expires-created>60_000
    || Object.entries(expected).some(([key,value])=>proof[key]!==value))throw new Error('quiescence proof unbound, stale or not approved');
}

export function assertDeferredStartGrant(grant, expected, now) {
  const keys=['formatVersion','operation','targetHost','contractDigest','candidateSha256','publicationDigest',
    'preRevision','postRevision','preimageDigest','mutationDigest','expectedDocumentsDigest','hostIdentitySha256','mongoIdentitySha256','leaseDigest',
    'pm2DefinitionDigest','stoppedRestartCount','externalBundleDigest','activationAt','createdAt','expiresAt',
    'effectiveUserDir','effectiveFlowPath','quiescenceEvidenceDigest'];
  if (!grant || Object.keys(grant).sort().join(',')!==keys.sort().join(',')) throw new Error('start grant schema mismatch');
  const created=Date.parse(grant.createdAt), expiry=Date.parse(grant.expiresAt), activation=Date.parse(grant.activationAt);
  for (const key of keys.filter(k=>k.endsWith('Digest')||k.endsWith('Sha256'))) {
    if (!SHA256_PATTERN.test(grant[key]||'')) throw new Error('start grant digest invalid');
  }
  if (grant.formatVersion!==1 || grant.operation!=='ACTIVATE_AND_START_PITER_ONLY' || grant.targetHost!==TARGET_HOST
    || !Number.isFinite(created) || !Number.isFinite(expiry) || !Number.isFinite(activation)
    || new Date(created).toISOString()!==grant.createdAt || new Date(expiry).toISOString()!==grant.expiresAt
    || new Date(activation).toISOString()!==grant.activationAt || created>now.getTime() || expiry<=now.getTime()
    || expiry-created>60_000 || activation<created || activation>now.getTime() || now.getTime()-activation>60_000
    || !Number.isSafeInteger(grant.preRevision) || grant.preRevision<0 || grant.postRevision!==grant.preRevision+1
    || !Number.isSafeInteger(grant.stoppedRestartCount) || grant.stoppedRestartCount<0
    || grant.effectiveUserDir!=='/root/.node-red' || grant.effectiveFlowPath!==LIVE_FLOW_PATH
    || Object.entries(expected).some(([k,v])=>grant[k]!==v)) throw new Error('start grant mismatch or expiry');
}

// This adapter is never constructed by synthetic tests. No PATH lookup or
// inherited operator environment is used to execute the approved PM2 script.
const createDeferredStartAdapter = () => {
  const pm2='/usr/local/lib/node_modules/pm2/bin/pm2';
  const command=(args,deadlineMs=null)=>{
    for (const file of [process.execPath,pm2]) {
      assertOwnedAncestors(file,0);
      const s=fs.lstatSync(file);
      if (!s.isFile() || s.isSymbolicLink() || s.uid!==0 || (s.mode&0o022)!==0) throw new Error('start executable custody');
    }
    if(args[0]==='start' && (!Number.isFinite(deadlineMs) || deadlineMs-Date.now()<START_REQUIRED_BUDGET_MS)) throw new Error('start deadline expired during executable custody');
    return spawnSync(process.execPath,[pm2,...args],{env:deferredStartEnvironment(),encoding:'utf8',timeout:START_COMMAND_TIMEOUT_MS,maxBuffer:8*1024*1024});
  };
  return {
    inspect(){ const r=command(['jlist']); if(r.error||r.status!==0)throw new Error('PM2 inspection unknown');return deferredPm2Identity(JSON.parse(r.stdout)); },
    start({deadlineMs}){ const r=command(['start','node-red'],deadlineMs);return {ok:!r.error&&r.status===0}; },
  };
};

// Pure orchestration seam: tests supply only synthetic adapters. The production
// caller below supplies protected files, actual lock/custody checks and reads.
export async function performDeferredGuardedStart({grant,expected,readGrant,check,postcheck,consume,persist,adapter,now}) {
  let intentDigest=null, dispatched=false;
  const validate = () => {
    if (stableJson(readGrant())!==stableJson(grant)) throw new Error('start grant changed');
    assertDeferredStartGrant(grant,expected,now());
  };
  try {
    validate();
    const proof=await check();
    const stopped=adapter.inspect();
    if (stopped.status!=='stopped'||stopped.pid!==0||stopped.restartCount!==grant.stoppedRestartCount
      ||stopped.definitionDigest!==grant.pm2DefinitionDigest)throw new Error('prestart process drift');
    validate();
    intentDigest=consume({formatVersion:1,state:'CONSUMED_NOT_DISPATCHED',grantDigest:sha256(stableJson(grant)),
      expected,proof,stopped,at:now().toISOString()});
    // Recheck after durable I/O: the intent may be spent even if this fails.
    const finalProof=await check();
    const finalStopped=adapter.inspect();
    if(stableJson(finalStopped)!==stableJson(stopped))throw new Error('final stopped identity drift');
    validate();
    if (!Number.isFinite(finalProof.validUntilMs) || finalProof.validUntilMs-now().getTime()<START_REQUIRED_BUDGET_MS) throw new Error('insufficient final dispatch deadline budget');
    dispatched=true;
    let ack=false;
    try { ack=adapter.start({deadlineMs:finalProof.validUntilMs})?.ok===true; } catch { /* ambiguous; inspect only */ }
    let current=null;
    try { current=adapter.inspect(); } catch { /* UNKNOWN */ }
    const exactOnline=current?.status==='online'&&current.pid>0&&current.restartCount===stopped.restartCount+1
      &&current.definitionDigest===stopped.definitionDigest;
    let custody=false;
    try { custody=await postcheck()===true; } catch { /* UNKNOWN */ }
    let finalCurrent=null;
    try { finalCurrent=adapter.inspect(); } catch { /* UNKNOWN */ }
    const stableOnline=exactOnline && stableJson(finalCurrent)===stableJson(current);
    const inDeadline=now().getTime()<finalProof.validUntilMs;
    // A dispatched command can take effect later even after timeout/nonzero.
    const state=custody&&ack&&stableOnline&&inDeadline?'STARTED':'UNKNOWN';
    const outcome={formatVersion:1,state,intentDigest,commandAcknowledged:ack,process:finalCurrent,
      at:now().toISOString(),salesOpeningVerified:false,retryAuthorized:false};
    persist(outcome);
    return outcome;
  } catch {
    if (intentDigest) {
      try { persist({formatVersion:1,state:dispatched?'UNKNOWN':'START_NOT_DISPATCHED',intentDigest,
        at:now().toISOString(),salesOpeningVerified:false,retryAuthorized:false}); } catch { /* retained intent blocks recovery */ }
    }
    throw new Error('guarded start blocked or outcome unknown; preserve evidence; no retry');
  }
}

const readRegular = (filePath, label, fsImpl = fs) => {
  const stat = fsImpl.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  return fsImpl.readFileSync(filePath);
};

const readJson = (filePath, label, fsImpl = fs) => JSON.parse(readRegular(filePath, label, fsImpl).toString("utf8"));

const snapshotDocuments = (payload, packet, now) => {
  const capturedAt = Date.parse(String(payload?.capturedAt || ""));
  const expectedQuery = {
    inventoryId: packet.target.inventoryId,
    counterKey: packet.target.counterKey,
    includeSentinel: true,
    includeAtomicSales: true,
  };
  if (!payload || typeof payload !== "object" || Array.isArray(payload)
    || payload.formatVersion !== 1 || payload.complete !== true
    || payload.source !== "MONGO_LK_TOURNAMENT_SUBSCRIPTION_SALES"
    || stableJson(payload.query) !== stableJson(expectedQuery)
    || !Number.isFinite(capturedAt) || new Date(capturedAt).toISOString() !== payload.capturedAt
    || capturedAt > now.getTime() + 60_000
    || now.getTime() - capturedAt > 5 * 60_000
    || !payload.pagination || payload.pagination.complete !== true
    || !Number.isInteger(payload.pagination.pages) || payload.pagination.pages < 1
    || !Array.isArray(payload.rows) || payload.pagination.rowCount !== payload.rows.length) {
    throw new Error("ledger evidence must be a complete exact Mongo v1 snapshot");
  }
  return payload.rows;
};

const activeFlowSha = (options, fsImpl) => (
  options.activeFlowFile ? sha256(readRegular(options.activeFlowFile, "active flow", fsImpl)) : null
);

const durableWriteExclusive = (target, bytes, fsImpl) => {
  const fd = fsImpl.openSync(target, "wx", 0o600);
  try {
    fsImpl.writeFileSync(fd, bytes);
    fsImpl.fsyncSync(fd);
  } finally {
    fsImpl.closeSync(fd);
  }
  const readback = fsImpl.readFileSync(target);
  if (!readback.equals(bytes)) throw new Error(`durable snapshot readback mismatch: ${path.basename(target)}`);
  return sha256(readback);
};

const createPrivateForensicSnapshot = (backupDir, payload, ejsonStringify, fsImpl = fs) => {
  if (fsImpl.existsSync(backupDir)) throw new Error("--backup-dir must not already exist");
  const parentStat = fsImpl.lstatSync(path.dirname(backupDir));
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()
    || (parentStat.mode & 0o077) !== 0) throw new Error("snapshot parent must be a private regular directory");
  fsImpl.mkdirSync(backupDir, { mode: 0o700 });
  const parentFd = fsImpl.openSync(path.dirname(backupDir), "r");
  try { fsImpl.fsyncSync(parentFd); } finally { fsImpl.closeSync(parentFd); }
  const dataBytes = Buffer.from(`${ejsonStringify(payload)}\n`, "utf8");
  const dataName = "piter-atomic-ledger.preimage.ejson";
  const dataSha256 = durableWriteExclusive(path.join(backupDir, dataName), dataBytes, fsImpl);
  const manifest = {
    formatVersion: 1,
    artifact: dataName,
    artifactSha256: dataSha256,
    byteLength: dataBytes.length,
    encoding: "MongoDB Extended JSON canonical",
    restoreRehearsed: false,
  };
  durableWriteExclusive(
    path.join(backupDir, "manifest.json"),
    Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
    fsImpl,
  );
  const directoryFd = fsImpl.openSync(backupDir, "r");
  try { fsImpl.fsyncSync(directoryFd); } finally { fsImpl.closeSync(directoryFd); }
  return { dataSha256, restoreRehearsed: false };
};

const assertProtectedCanonicalFlow = (options, fsImpl, liveFlowPath, expectedUid) => {
  if (options.activeFlowFile !== liveFlowPath) throw new Error(`--active-flow must equal ${liveFlowPath}`);
  const stat = fsImpl.lstatSync(liveFlowPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== expectedUid || (stat.mode & 0o022) !== 0) {
    throw new Error("canonical active flow ownership or mode mismatch");
  }
};

const linuxDeviceNumbers = (device) => {
  const value = BigInt(device);
  return {
    major: ((value >> 8n) & 0xfffn) | ((value >> 32n) & ~0xfffn),
    minor: (value & 0xffn) | ((value >> 12n) & ~0xffn),
  };
};

export const processOwnsExclusiveFlock = ({ procLocks, pid, lockStat, openFileStats }) => {
  const { major, minor } = linuxDeviceNumbers(lockStat.dev);
  const inode = BigInt(lockStat.ino);
  const ownsDescriptor = openFileStats.some((stat) => (
    BigInt(stat.dev) === BigInt(lockStat.dev) && BigInt(stat.ino) === inode
  ));
  if (!ownsDescriptor) return false;
  return String(procLocks).split("\n").some((line) => {
    const match = line.match(/^\d+:\s+(?:->\s+)?FLOCK\s+ADVISORY\s+WRITE\s+(\d+)\s+([0-9a-f]+):([0-9a-f]+):(\d+)\s/iu);
    return Boolean(match)
      && Number(match[1]) === pid
      && BigInt(`0x${match[2]}`) === major
      && BigInt(`0x${match[3]}`) === minor
      && BigInt(match[4]) === inode;
  });
};

export const verifyDeploymentLock = ({
  fsImpl = fs,
  lockPath = DEPLOYMENT_LOCK_PATH,
  expectedUid = 0,
  pid = process.pid,
  platform = process.platform,
} = {}) => {
  if (platform !== "linux") return false;
  const lockStat = fsImpl.lstatSync(lockPath, { bigint: true });
  if (!lockStat.isFile() || lockStat.isSymbolicLink()
    || lockStat.uid !== BigInt(expectedUid) || (lockStat.mode & 0o077n) !== 0n) return false;
  const openFileStats = [];
  for (const entry of fsImpl.readdirSync("/proc/self/fd")) {
    if (!/^\d+$/u.test(entry)) continue;
    try {
      openFileStats.push(fsImpl.statSync(`/proc/self/fd/${entry}`, { bigint: true }));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return processOwnsExclusiveFlock({
    procLocks: fsImpl.readFileSync("/proc/locks", "utf8"),
    pid,
    lockStat,
    openFileStats,
  });
};

const assertApplyAuthorization = (options, packet, env, runtime) => {
  if (runtime.getUid() !== runtime.expectedUid) throw new Error("live ledger apply requires the canonical runtime owner");
  if (runtime.verifyDeploymentLock() !== true) {
    throw new Error("reviewed-flow deployment lock is not held by this process");
  }
  if (env.LK_PITER_DEFERRED_TARGET !== TARGET_HOST) throw new Error(`LK_PITER_DEFERRED_TARGET must equal ${TARGET_HOST}`);
  if (env.LK_PITER_DEFERRED_LEDGER_ACTION !== APPLY_GATES[options.action]) {
    throw new Error(`LK_PITER_DEFERRED_LEDGER_ACTION must equal ${APPLY_GATES[options.action]}`);
  }
  if (!SHA256_PATTERN.test(String(options.expectedContractDigest || ""))
    || options.expectedContractDigest !== packet.contractDigest) {
    throw new Error("--expected-contract-digest must exactly match the private packet");
  }
  if (!options.backupDir) throw new Error("--backup-dir is required with --apply");
  if (!toStr(env.LK_PITER_DEFERRED_MONGO_URI)) throw new Error("LK_PITER_DEFERRED_MONGO_URI is required with --apply");
  if (!SHA256_PATTERN.test(String(env.LK_PITER_DEFERRED_EXPECTED_MONGO_IDENTITY_SHA256 || ""))) {
    throw new Error("LK_PITER_DEFERRED_EXPECTED_MONGO_IDENTITY_SHA256 must be an exact SHA-256");
  }
  if (!SHA256_PATTERN.test(String(env.LK_PITER_DEFERRED_EXPECTED_HOST_IDENTITY_SHA256 || ""))) {
    throw new Error("LK_PITER_DEFERRED_EXPECTED_HOST_IDENTITY_SHA256 must be an exact SHA-256");
  }
  assertProtectedCanonicalFlow(options, runtime.fsImpl, runtime.liveFlowPath, runtime.expectedUid);
};

const queryDocuments = async (collection, packet) => collection.find({
  $or: [
    { _id: packet.target.ledgerId },
    { counterKey: packet.target.counterKey, inventoryId: packet.target.inventoryId },
  ],
}, { readConcern: { level: "majority" }, maxTimeMS: MAX_MONGO_TIME_MS, promoteValues:false }).toArray();

const exactWriteAck = (result, mutationType, ledgerId) => {
  if (mutationType === "insertOne") return result?.acknowledged === true && result.insertedId === ledgerId;
  return result?.acknowledged === true && result.matchedCount === 1 && result.modifiedCount === 1
    && result.upsertedCount === 0 && result.upsertedId == null;
};

const mongoIdentityDigest = async (client) => {
  const hello = await client.db("admin").command({ hello: 1 }, { maxTimeMS: MAX_MONGO_TIME_MS });
  const identity = {
    setName: toStr(hello?.setName),
    hosts: Array.isArray(hello?.hosts) ? hello.hosts.map(String).sort() : [],
    me: toStr(hello?.me),
    primary: toStr(hello?.primary),
  };
  if (!identity.setName || identity.hosts.length < 1 || !identity.me || !identity.primary) {
    throw new Error("Mongo deployment identity is incomplete");
  }
  return sha256(stableJson(identity));
};

const validateDeploymentLease = (lease, packet, now) => {
  const earliestEvidenceAt = Math.min(
    Date.parse(packet.evidence.ledgerCapturedAt),
    Date.parse(packet.evidence.providerCapturedAt),
    Date.parse(packet.evidence.productCapturedAt),
    Date.parse(packet.evidence.bindingCapturedAt),
    Date.parse(packet.evidence.subscriptionCapturedAt),
    Date.parse(packet.evidence.attemptsCapturedAt),
  );
  if (!lease || lease.formatVersion !== 2 || lease.deploymentId !== packet.deployment.deploymentId
    || typeof lease.token !== "string" || !lease.token.trim()
    || lease.sourceSha256 !== packet.deployment.sourceSha256
    || lease.candidateSha256 !== packet.deployment.candidateSha256 || lease.phase !== "soaking"
    || !Number.isInteger(lease.acquiredAtMs) || lease.acquiredAtMs > earliestEvidenceAt
    || !Number.isInteger(lease.expiresAtMs) || lease.expiresAtMs <= lease.acquiredAtMs
    || lease.expiresAtMs <= now.getTime()) {
    throw new Error("matching non-expired reviewed-flow soaking lease is required");
  }
};

// Compute the only allowed full postimage; never retry or repair a mismatch.
export function expectedDeferredPostimage(before, mutation, ledgerId) {
  // Preserve BSON prototypes in untouched fields; mutation keys are top-level.
  const rows = before.map(row=>({...row}));
  if (mutation.type === 'insertOne') {
    if (rows.some(r => r._id === ledgerId) || mutation.document._id !== ledgerId) throw new Error('insert identity');
    rows.push(structuredClone(mutation.document));
  } else if (mutation.type === 'updateOne') {
    const row = rows.find(r => r._id === ledgerId);
    if (!row || mutation.filter._id !== ledgerId || Object.keys(mutation.update).some(k => !['$set','$inc'].includes(k))) throw new Error('update identity');
    Object.assign(row, structuredClone(mutation.update.$set || {}));
    for (const [key,value] of Object.entries(mutation.update.$inc || {})) {
      const previous = row[key]?._bsontype === 'Int32' ? row[key].valueOf() : row[key];
      if (!Number.isSafeInteger(previous) || !Number.isSafeInteger(value)) throw new Error('increment shape');
      row[key] = previous + value;
    }
  } else throw new Error('mutation type');
  return rows;
}

export function digestDeferredBsonDocuments(rows, ejsonStringify) {
  if (typeof ejsonStringify !== 'function') throw new Error('canonical EJSON runtime required');
  const canonical = rows.map(r => stableJson(JSON.parse(ejsonStringify(r)))).sort();
  return sha256(JSON.stringify(canonical));
}

export function normalizeDeferredBusinessDocuments(rows, ledgerId) {
  const ledger=rows.find(r=>r._id===ledgerId);
  for(const key of ['schemaVersion','revision','paidCount','reservedCount','takenCount','quotaAdjustment']) {
    if (ledger?.[key]?._bsontype && ledger[key]._bsontype !== 'Int32') throw new Error('sentinel BSON integer type drift');
  }
  return JSON.parse(JSON.stringify(rows));
}

export function assertDeferredPublicationReadback(packet, descriptor, installedHashes) {
  const claim=packet.inputs.publication;
  if (!descriptor || Object.keys(descriptor).sort().join(',') !== ['formatVersion','sourceCommit','runtimeSourceTree','candidateSha256','forwardContractSha256','scriptHashes'].sort().join(',')
    || descriptor.formatVersion!==1 || sha256(stableJson(descriptor))!==claim.releaseManifestSha256
    || descriptor.sourceCommit!==claim.sourceCommit || descriptor.runtimeSourceTree!==claim.runtimeSourceTree
    || descriptor.candidateSha256!==claim.candidateSha256 || descriptor.forwardContractSha256!==claim.forwardContractSha256
    || stableJson(descriptor.scriptHashes)!==stableJson(installedHashes)
    || Object.keys(installedHashes).sort().join(',')!==[...PUBLICATION_SCRIPTS].sort().join(',')) throw new Error('protected publication readback mismatch');
}

const readPublication = (packet, expectedUid) => {
  const parent=fs.lstatSync(path.dirname(PUBLICATION_PATH));
  if(!parent.isDirectory()||parent.isSymbolicLink()||parent.uid!==expectedUid||(parent.mode&0o077)!==0)throw new Error('publication directory custody');
  const descriptor=readPrivateDeferredJson(PUBLICATION_PATH,expectedUid);
  const hashes=Object.fromEntries(PUBLICATION_SCRIPTS.map(name=>{
    const file=fileURLToPath(new URL(name,import.meta.url));
    const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    try{const st=fs.fstatSync(fd);if(!st.isFile()||st.uid!==expectedUid||(st.mode&0o022)!==0)throw new Error('installed tool custody');return [name,sha256(fs.readFileSync(fd))];}finally{fs.closeSync(fd);}
  }));
  assertDeferredPublicationReadback(packet,descriptor,hashes);
  return sha256(stableJson(descriptor));
};

export function assertDeferredRuntimeStopped(state) {
  if (!state || state.status!=='stopped'||state.pid!==0||!Number.isSafeInteger(state.restartCount)||state.restartCount<0)throw new Error('canonical Node-RED must already be stopped');
  return {status:state.status,pid:state.pid,restartCount:state.restartCount};
}

const exactPostcondition = ({ action, after, beforePlan, packet, expectedRevision, reason }) => {
  const sentinel = after.find((row) => row?._id === packet.target.ledgerId);
  if (!sentinel) return null;
  let shapeValid = true;
  try {
    validateAtomicLedgerShape(sentinel, packet.target.totalLimit);
  } catch {
    shapeValid = false;
    try { validateAtomicLedgerCustody(sentinel); } catch { return null; }
  }
  if (sentinel.activationContractDigest !== packet.contractDigest
    || sentinel.baselineDigest !== packet.baseline.digest
    || stableJson(sentinel.legacyPaymentRefs) !== stableJson(packet.baseline.legacyPaymentRefs)) return null;
  if (action === "seed" || action === "activate") {
    if (!shapeValid || sentinel.schemaVersion !== (packet.launchQuota ? 2 : 1)
      || (packet.launchQuota ? sentinel.quotaAdjustment !== packet.launchQuota.adjustment
        : Object.hasOwn(sentinel, "quotaAdjustment"))) return null;
  } else {
    const custody = beforePlan.preDeactivateQuotaCustody;
    if (!custody || sentinel.schemaVersion !== custody.schemaVersion
      || Object.hasOwn(sentinel, "quotaAdjustment") !== custody.hasQuotaAdjustment
      || sentinel.quotaAdjustment !== custody.quotaAdjustment) return null;
  }
  if (action === "seed") {
    return sentinel.ready === false && sentinel.revision === 0
      && sentinel.reservations.length === 0 && sentinel.reservedCount === 0
      && sentinel.paidCount === packet.baseline.paidCount
      && sentinel.takenCount === packet.baseline.paidCount ? sentinel : null;
  }
  if (action === "activate") {
    return shapeValid && sentinel.ready === true && sentinel.revision >= expectedRevision + 1
      && sentinel.activationBaseRevision === expectedRevision
      && sentinel.activationDeploymentId === packet.deployment.deploymentId ? sentinel : null;
  }
  const markerMatches = sentinel.ready === false && sentinel.revision >= expectedRevision + 1
    && sentinel.deactivationReason === toStr(reason)
    && sentinel.deactivationBaseRevision === expectedRevision;
  if (!markerMatches) return null;
  if (sentinel.revision === expectedRevision + 1) {
    const counts = beforePlan.preDeactivateCounts || {};
    return sentinel.paidCount === counts.paidCount
      && sentinel.reservedCount === counts.reservedCount
      && sentinel.takenCount === counts.takenCount ? sentinel : null;
  }
  if (!shapeValid) return null;
  const beforeReservations = Array.isArray(beforePlan.preDeactivateReservations)
    ? beforePlan.preDeactivateReservations : [];
  if (sentinel.reservations.length !== beforeReservations.length) return null;
  const afterByPaymentRef = new Map(sentinel.reservations.map((item) => [toStr(item?.paymentRef), item]));
  const validTransition = beforeReservations.every((previous) => {
    const current = afterByPaymentRef.get(toStr(previous?.paymentRef));
    if (!current || current.intentFingerprint !== previous.intentFingerprint) return false;
    if (previous.transactionId && current.transactionId !== previous.transactionId) return false;
    if (["PAID", "FAILED"].includes(previous.state) && current.state !== previous.state) return false;
    return true;
  });
  return validTransition ? sentinel : null;
};

export async function runDeferredLedgerOperation(options, dependencies = {}) {
  const fsImpl = dependencies.fsImpl || fs;
  const env = dependencies.env || process.env;
  const nowFn = dependencies.now || (() => new Date());
  if (options.guardedStart && (!options.apply || options.action!=='activate'
    || env.LK_PITER_DEFERRED_START_ACTION!=='DEFERRED_START_PITER_ONLY_147')) throw new Error('guarded start disabled or invalid scope');
  const runtime = {
    fsImpl,
    liveFlowPath: dependencies.liveFlowPath || LIVE_FLOW_PATH,
    expectedUid: dependencies.expectedUid ?? 0,
    getUid: dependencies.getUid || (() => process.getuid?.()),
    verifyDeploymentLock: dependencies.verifyDeploymentLock || (() => verifyDeploymentLock({
      fsImpl,
      expectedUid: dependencies.expectedUid ?? 0,
    })),
  };
  const startedAt = freshNow(nowFn);
  const packet = options.apply ? readPrivateDeferredJson(options.packetFile, runtime.expectedUid)
    : readJson(options.packetFile, "activation packet", fsImpl);
  validatePiterDeferredActivationPacket(packet, {
    now: startedAt,
    allowExpired: options.action === "deactivate" || options.action === "rollback-check",
  });
  const flowSha256 = activeFlowSha(options, fsImpl);
  const checkProvider = (now, minRemainingMs = 0) => {
    if (options.action !== 'activate') return;
    const bundle = readPrivateDeferredJson(options.activationRecheckFile, runtime.expectedUid);
    assertFreshDeferredActivationRecheck(bundle, packet, now);
    const expiresAt = Math.min(...Object.values(bundle).map(e=>Date.parse(e.capturedAt))) + 15_000;
    // Sample after the potentially slow file read and full evidence validation.
    const boundaryNow = freshNow(nowFn);
    if (expiresAt - boundaryNow.getTime() < minRemainingMs) throw new Error('insufficient external evidence deadline budget');
  };
  if (!options.apply) {
    checkProvider(startedAt);
    const plan = buildPiterDeferredLedgerPlan({
      action: options.action,
      packet,
      documents: snapshotDocuments(readJson(options.ledgerFile, "ledger evidence", fsImpl), packet, startedAt),
      activeFlowSha256: flowSha256,
      expectedRevision: options.expectedRevision,
      now: startedAt,
      reason: options.reason,
    });
    return redactPiterDeferredLedgerPlan(plan);
  }

  assertApplyAuthorization(options, packet, env, runtime);
  const inspectStopped = dependencies.inspectStoppedRuntime || (()=>createPm2Adapter().inspect());
  const initialStopped = assertDeferredRuntimeStopped(inspectStopped());
  const publicationProof = dependencies.readPublicationProof || (()=>readPublication(packet,runtime.expectedUid));
  const initialPublication = publicationProof();
  if (initialPublication !== packet.inputs.publication.releaseManifestSha256) throw new Error('publication custody is unbound');
  const mongodb = dependencies.client ? dependencies.mongodb : (dependencies.mongodb || await import("mongodb"));
  const client = dependencies.client || new mongodb.MongoClient(env.LK_PITER_DEFERRED_MONGO_URI, {
    serverSelectionTimeoutMS: 10_000,
    socketTimeoutMS: 10_000,
  });
  const ownsClient = !dependencies.client;
  const readLease = dependencies.readDeploymentLease
    || (() => readJson(DEPLOYMENT_LEASE_PATH, "reviewed-flow deployment lease", fsImpl));
  const readHostIdentitySha256 = dependencies.readHostIdentitySha256
    || (() => sha256(readRegular("/etc/machine-id", "host machine identity", fsImpl).toString("utf8").trim()));
  const ejsonStringify = dependencies.ejsonStringify
    || ((value) => mongodb.BSON.EJSON.stringify(value, null, 2, { relaxed: false }));
  let startContext=null;
  try {
    if (ownsClient) await client.connect();
    const actualHostIdentitySha256 = readHostIdentitySha256();
    if (actualHostIdentitySha256 !== env.LK_PITER_DEFERRED_EXPECTED_HOST_IDENTITY_SHA256) {
      throw new Error("runtime host identity does not match the authorized target");
    }
    const actualMongoIdentitySha256 = await mongoIdentityDigest(client);
    if (actualMongoIdentitySha256 !== env.LK_PITER_DEFERRED_EXPECTED_MONGO_IDENTITY_SHA256) {
      throw new Error("Mongo deployment identity does not match the authorized target");
    }
    const collection = client.db("games").collection(packet.target.collection);
    const initialLease = ['seed','activate'].includes(options.action) ? structuredClone(readLease()) : null;
    const assertCurrentCustody = (now, minRemainingMs, postWrite = false) => {
      validatePiterDeferredActivationPacket(packet, { now, allowExpired:options.action === 'deactivate' });
      assertApplyAuthorization(options, packet, env, runtime);
      if (stableJson(assertDeferredRuntimeStopped(inspectStopped())) !== stableJson(initialStopped)) throw new Error('stopped runtime identity drift');
      if (publicationProof() !== initialPublication) throw new Error('publication custody drift');
      const currentFlow = activeFlowSha(options, fsImpl);
      if (initialLease) {
        const lease = readLease();
        validateDeploymentLease(lease, packet, now);
        if (stableJson(lease) !== stableJson(initialLease)) throw new Error('lease identity or token drift');
        if (currentFlow !== packet.deployment.candidateSha256) throw new Error('canonical flow drift');
        if (Math.min(Date.parse(packet.expiresAt), lease.expiresAtMs) - now.getTime() < minRemainingMs) throw new Error('insufficient evidence/lease deadline budget');
      }
      // External freshness is a mutation precondition, not a post-write receipt
      // condition. Slow write/readback must not invalidate an exact successful C.
      // Runtime remains stopped; this receipt never authorizes a later start.
      if (!postWrite) checkProvider(now, minRemainingMs > 0 ? 1_000 : 0);
      if (startContext) {
        if (env.LK_PITER_DEFERRED_START_ACTION!=='DEFERRED_START_PITER_ONLY_147') throw new Error('start phrase drift');
        const {grant,expected,readGrant,adapter}=startContext;
        if (stableJson(readGrant())!==stableJson(grant)) throw new Error('start grant drift');
        assertDeferredStartGrant(grant,expected,freshNow(nowFn));
        startContext.checkQuiescence(freshNow(nowFn));
        const bundle=readPrivateDeferredJson(options.activationRecheckFile,runtime.expectedUid);
        if (sha256(stableJson(bundle))!==grant.externalBundleDigest) throw new Error('authorized external bundle drift');
        const state=adapter.inspect();
        if (state.status!=='stopped'||state.pid!==0||state.definitionDigest!==grant.pm2DefinitionDigest
          ||state.restartCount!==grant.stoppedRestartCount)throw new Error('start process definition drift');
      }
      return currentFlow;
    };
    assertCurrentCustody(freshNow(nowFn), 3 * MAX_MONGO_TIME_MS);
    const before = await queryDocuments(collection, packet);
    const assertCanonicalLegacy = docs => {
      if (['seed','activate'].includes(options.action)) {
        const legacy=docs.filter(r=>r._id!==packet.target.ledgerId&&!String(r._id).startsWith('piter-sale:'));
        if(digestDeferredBsonDocuments(legacy,ejsonStringify)!==packet.evidence.canonicalLegacyDocumentsSha256)throw new Error('canonical legacy capture drift');
      }
    };
    assertCanonicalLegacy(before);
    let planAt=startedAt;
    let plan = buildPiterDeferredLedgerPlan({
      action: options.action,
      packet,
      documents: normalizeDeferredBusinessDocuments(before,packet.target.ledgerId),
      activeFlowSha256: flowSha256,
      expectedRevision: options.expectedRevision,
      now: startedAt,
      reason: options.reason,
    });
    if (!plan.mutation) {
      if (options.guardedStart) throw new Error('guarded start refuses already-applied/no-mutation replay');
      return {
        ...redactPiterDeferredLedgerPlan(plan),
        mutationPerformed: false,
        alreadyApplied: plan.outcome === "ALREADY_APPLIED",
        hostIdentitySha256: actualHostIdentitySha256,
        mongoIdentitySha256: actualMongoIdentitySha256,
      };
    }

    if (options.guardedStart) {
      const readGrant=dependencies.readStartGrant || (()=>readStartGrant(runtime.expectedUid));
      const grant=readGrant();
      assertDeferredStartGrant(grant,{},freshNow(nowFn));
      if (Date.parse(grant.activationAt)<Date.parse(packet.createdAt)) throw new Error('authorized activation predates packet');
      planAt=new Date(grant.activationAt);
      plan=buildPiterDeferredLedgerPlan({action:options.action,packet,documents:normalizeDeferredBusinessDocuments(before,packet.target.ledgerId),
        activeFlowSha256:flowSha256,expectedRevision:options.expectedRevision,now:planAt,reason:options.reason});
      if (plan.mutation?.type!=='updateOne' || plan.mutation.update.$set.ready!==true || plan.mutation.filter.ready!==false) throw new Error('guarded start requires exact activation CAS');
      const expected={contractDigest:packet.contractDigest,candidateSha256:packet.deployment.candidateSha256,
        publicationDigest:initialPublication,preRevision:options.expectedRevision,postRevision:options.expectedRevision+1,
        preimageDigest:digestDeferredBsonDocuments(before,ejsonStringify),mutationDigest:sha256(stableJson(plan.mutation)),
        expectedDocumentsDigest:digestDeferredBsonDocuments(expectedDeferredPostimage(before,plan.mutation,packet.target.ledgerId),ejsonStringify),
        hostIdentitySha256:actualHostIdentitySha256,mongoIdentitySha256:actualMongoIdentitySha256,leaseDigest:sha256(stableJson(initialLease))};
      const readQuiescence=dependencies.readQuiescenceProof || (()=>{
        assertOwnedAncestors(QUIESCENCE_PROOF_PATH,runtime.expectedUid);
        return readPrivateDeferredJson(QUIESCENCE_PROOF_PATH,runtime.expectedUid);
      });
      const quiescenceExpected=Object.fromEntries(['hostIdentitySha256','mongoIdentitySha256','candidateSha256',
        'publicationDigest','leaseDigest','preimageDigest'].map(k=>[k,expected[k]]));
      Object.assign(quiescenceExpected,{pm2DefinitionDigest:grant.pm2DefinitionDigest,stoppedRestartCount:grant.stoppedRestartCount,
        effectiveUserDir:grant.effectiveUserDir,effectiveFlowPath:grant.effectiveFlowPath});
      const quiescence=readQuiescence();
      expected.quiescenceEvidenceDigest=sha256(stableJson(quiescence));
      const checkQuiescence=now=>{
        const current=readQuiescence();
        if(sha256(stableJson(current))!==expected.quiescenceEvidenceDigest)throw new Error('quiescence proof drift');
        assertDeferredQuiescenceProof(current,quiescenceExpected,now);
      };
      checkQuiescence(freshNow(nowFn));
      assertDeferredStartGrant(grant,expected,freshNow(nowFn));
      const assertUnused=dependencies.assertStartUnused || (()=>{
        for(const file of [START_INTENT_PATH,START_RESULT_PATH]){
          assertOwnedAncestors(file,runtime.expectedUid);
          for(const target of [file,file+'.pending']){
            try { fs.lstatSync(target); } catch(error){if(error.code==='ENOENT')continue;throw error;}
            throw new Error('start authorization already consumed or recovery incomplete');
          }
        }
      });
      assertUnused();
      startContext={grant,expected,readGrant,assertUnused,checkQuiescence,quiescenceExpiresAt:Date.parse(quiescence.expiresAt),
        adapter:dependencies.startAdapter || createDeferredStartAdapter()};
    }

    const commitAt = freshNow(nowFn);
    assertCurrentCustody(commitAt, 3 * MAX_MONGO_TIME_MS);
    const forensicSnapshot = createPrivateForensicSnapshot(options.backupDir, {
      formatVersion: 1,
      capturedAt: commitAt.toISOString(),
      contractDigest: packet.contractDigest,
      action: options.action,
      documents: before,
      stoppedRuntime: initialStopped,
      publicationDigest: initialPublication,
    }, ejsonStringify, fsImpl);
    assertCurrentCustody(freshNow(nowFn), 3 * MAX_MONGO_TIME_MS);
    const secondRead = await queryDocuments(collection, packet);
    assertCanonicalLegacy(secondRead);
    if (digestDeferredBsonDocuments(secondRead, ejsonStringify) !== digestDeferredBsonDocuments(before, ejsonStringify)) throw new Error('full preimage drift before write');
    const secondPlan = buildPiterDeferredLedgerPlan({ action:options.action, packet, documents:normalizeDeferredBusinessDocuments(secondRead,packet.target.ledgerId),
      activeFlowSha256:activeFlowSha(options, fsImpl), expectedRevision:options.expectedRevision,
      now:planAt, reason:options.reason });
    if (stableJson(secondPlan) !== stableJson(plan)) throw new Error('deterministic plan drift');
    const writeAt = freshNow(nowFn);
    const writeFlowSha256 = assertCurrentCustody(writeAt, 2 * MAX_MONGO_TIME_MS);
    const mutation = plan.mutation;
    const expectedAfter = expectedDeferredPostimage(before, mutation, packet.target.ledgerId);
    if(startContext)startContext.assertUnused();
    let writeResult = null;
    let writeError = null;
    try {
      writeResult = mutation.type === "insertOne"
        ? await collection.insertOne(mutation.document, {
          writeConcern: { w: "majority", j: true }, maxTimeMS: MAX_MONGO_TIME_MS,
        })
        : await collection.updateOne(mutation.filter, mutation.update, {
          upsert: false, writeConcern: { w: "majority", j: true }, maxTimeMS: MAX_MONGO_TIME_MS,
        });
    } catch (error) {
      writeError = error;
    }
    const after = await queryDocuments(collection, packet);
    assertCurrentCustody(freshNow(nowFn),0,true);
    if (digestDeferredBsonDocuments(after, ejsonStringify) !== digestDeferredBsonDocuments(expectedAfter, ejsonStringify)) throw new Error('full postimage mismatch; no retry authorized');
    const sentinel = exactPostcondition({
      action: options.action,
      after:normalizeDeferredBusinessDocuments(after,packet.target.ledgerId),
      beforePlan: plan,
      packet,
      expectedRevision: options.expectedRevision,
      reason: options.reason,
    });
    if (!sentinel) {
      if (writeError) throw new Error('Mongo write outcome unresolved after readback; inspect private backup');
      if (!exactWriteAck(writeResult, mutation.type, packet.target.ledgerId)) {
        throw new Error("exact Mongo write acknowledgement and postcondition were not received");
      }
      throw new Error("post-write sentinel readback mismatch");
    }
    const acknowledged = exactWriteAck(writeResult, mutation.type, packet.target.ledgerId);
    let startOutcome=null;
    if(startContext){
      const {grant,expected,readGrant,adapter}=startContext;
      const check=async()=>{
        assertCurrentCustody(freshNow(nowFn),0);
        if(readHostIdentitySha256()!==actualHostIdentitySha256 || await mongoIdentityDigest(client)!==actualMongoIdentitySha256) throw new Error('prestart target identity drift');
        const current=await queryDocuments(collection,packet);
        if(digestDeferredBsonDocuments(current,ejsonStringify)!==expected.expectedDocumentsDigest)throw new Error('prestart full C drift');
        assertCurrentCustody(freshNow(nowFn),0);
        const bundle=readPrivateDeferredJson(options.activationRecheckFile,runtime.expectedUid);
        const bundleDigest=sha256(stableJson(bundle));
        if(bundleDigest!==grant.externalBundleDigest)throw new Error('prestart external bundle drift');
        assertFreshDeferredActivationRecheck(bundle,packet,freshNow(nowFn));
        const boundaryNow=freshNow(nowFn);
        const expires=Math.min(Date.parse(grant.expiresAt),Date.parse(packet.expiresAt),initialLease.expiresAtMs,startContext.quiescenceExpiresAt,
          ...Object.values(bundle).map(e=>Date.parse(e.capturedAt)+15_000));
        if(expires-boundaryNow.getTime()<START_REQUIRED_BUDGET_MS)throw new Error('prestart evidence deadline');
        return {fullDocumentsDigest:expected.expectedDocumentsDigest,externalBundleDigest:bundleDigest,validUntilMs:expires,
          captures:Object.fromEntries(Object.entries(bundle).map(([k,e])=>[k,e.capturedAt])),observedAt:boundaryNow.toISOString()};
      };
      startContext.assertUnused();
      startOutcome=await performDeferredGuardedStart({grant,expected,readGrant,check,adapter,now:()=>freshNow(nowFn),
        postcheck:async()=>{
          assertApplyAuthorization(options,packet,env,runtime);
          if(publicationProof()!==initialPublication || activeFlowSha(options,fsImpl)!==packet.deployment.candidateSha256
            || stableJson(readLease())!==stableJson(initialLease) || readHostIdentitySha256()!==actualHostIdentitySha256
            || await mongoIdentityDigest(client)!==actualMongoIdentitySha256)throw new Error('poststart custody drift');
          validateDeploymentLease(initialLease,packet,freshNow(nowFn));
          startContext.checkQuiescence(freshNow(nowFn));
          return true;
        },
        consume:dependencies.consumeStartIntent || (p=>publishDeferredStartEvidence(START_INTENT_PATH,p,runtime.expectedUid)),
        persist:dependencies.persistStartResult || (p=>publishDeferredStartEvidence(START_RESULT_PATH,p,runtime.expectedUid))});
    }
    return {
      ...redactPiterDeferredLedgerPlan(plan),
      mutationPerformed: true,
      stoppedRuntime:initialStopped,
      publicationDigest:initialPublication,
      startAuthorized:false,
      startOutcome,
      ambiguousWriteRecovered: Boolean(writeError || !acknowledged),
      postRevision: sentinel.revision,
      postReady: sentinel.ready,
      canonicalFlowSha256: writeFlowSha256,
      runtimeStopProven: options.action !== "deactivate" || writeFlowSha256 === packet.deployment.candidateSha256,
      hostIdentitySha256: actualHostIdentitySha256,
      mongoIdentitySha256: actualMongoIdentitySha256,
      forensicSnapshotCreated: true,
      forensicSnapshotSha256: forensicSnapshot.dataSha256,
      restoreRehearsed: false,
    };
  } finally {
    if (ownsClient) await client.close();
  }
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) { process.stdout.write(usage); return; }
    if (options.apply && process.env[DEPLOYMENT_LOCK_WRAPPED_ENV] !== "1") {
      const result = spawnSync("flock", [
        "-n", "-E", "75", "-F", DEPLOYMENT_LOCK_PATH,
        "env", `${DEPLOYMENT_LOCK_WRAPPED_ENV}=1`, process.execPath, fileURLToPath(import.meta.url),
        ...process.argv.slice(2),
      ], { stdio: "inherit", env: process.env });
      if (result.error) throw result.error;
      process.exitCode = result.status ?? 1;
      return;
    }
    process.stdout.write(`${JSON.stringify(await runDeferredLedgerOperation(options), null, 2)}\n`);
  } catch {
    console.error("Piter deferred operation blocked; inspect private evidence. No automatic retry.");
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
