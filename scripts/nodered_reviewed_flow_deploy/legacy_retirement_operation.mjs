#!/usr/bin/env node
// Importing this module never reads production, writes files or starts a process.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createPm2Adapter } from './deploy_reviewed_flow_147_remote.mjs';
import { atomicWrite, canonicalFlowSha256, recoverAtomicExclusivePublication, sha256, syncDirectory, writeFileExclusiveAtomicDurable, writeFileExclusiveDurable } from './runtime_contract.mjs';
import { RETIREMENT_SOURCE_FILES, validateLegacyRetirementContract } from './legacy_retirement_contract.mjs';

const ROOT = '/root/.node-red';
const LOCK = `${ROOT}/.padlhub-reviewed-flow-deploy.lock`;
const AUTHORIZE = 'RETIRE_14_LEGACY_NODES_147_FORWARD_ONLY';
const SOAK_MS = 15 * 60 * 1000;
const check = (ok, code) => { if (!ok) throw new Error(code); };
const hex = s => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);

export function createLegacyRetirementOperation({ stage, contractSha256, stageParent = ROOT, uid = 0, gid = 0,
  getUid = () => process.getuid?.(), now = Date.now, randomUUID = crypto.randomUUID,
  readMachineId = () => sha256(fs.readFileSync('/etc/machine-id')),
  readRuntimeFingerprint = pid => sha256(JSON.stringify({ executable: fs.readlinkSync(`/proc/${pid}/exe`),
    cwd: fs.readlinkSync(`/proc/${pid}/cwd`), argsSha256: sha256(fs.readFileSync(`/proc/${pid}/cmdline`)),
    settingsSha256: sha256(fs.readFileSync(path.join(stageParent, 'settings.js'))) })),
  pm2 = createPm2Adapter(), bindings, onTransition = () => {} } = {}) {
  const live = path.join(stageParent, 'flows.json'), leasePath = path.join(stageParent, '.padlhub-reviewed-flow-deploy.lease.json');
  const backup = path.join(stageParent, '.padlhub-reviewed-flow-backups');
  check(hex(contractSha256), 'RETIREMENT_PACKET_DIGEST');
  const op = path.join(backup, `retirement-${contractSha256}`), journalPath = path.join(op, 'journal.json');
  const protectedOptions = { uid, gid, mode: 0o600 };
  function directory(p, exactMode) {
    const st = fs.lstatSync(p);
    check(st.isDirectory() && !st.isSymbolicLink() && st.uid === uid && st.gid === gid
      && fs.realpathSync(p) === path.resolve(p) && (exactMode === undefined ? !(st.mode & 0o022) : (st.mode & 0o777) === exactMode), 'RETIREMENT_DIRECTORY_CUSTODY');
  }
  function read(p, modes = [0o600], links = [1]) {
    const fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const st = fs.fstatSync(fd), bytes = fs.readFileSync(fd), after = fs.lstatSync(p);
      check(st.isFile() && links.includes(st.nlink) && st.uid === uid && st.gid === gid && modes.includes(st.mode & 0o777)
        && !after.isSymbolicLink() && st.ino === after.ino && st.dev === after.dev && st.size === after.size && st.mtimeMs === after.mtimeMs, 'RETIREMENT_FILE_CUSTODY');
      return bytes;
    } finally { fs.closeSync(fd); }
  }
  const json = p => JSON.parse(read(p).toString('utf8'));
  const exclusive = (p, value) => writeFileExclusiveDurable(p, Buffer.isBuffer(value) ? value : Buffer.from(`${JSON.stringify(value, null, 2)}\n`), protectedOptions);
  function packet() {
    check(getUid() === uid, 'RETIREMENT_OWNER'); directory(stageParent);
    check(path.isAbsolute(stage) && path.dirname(stage) === stageParent
      && /^\.padlhub-reviewed-flow-stage-\d{8}T\d{6}[+-]\d{4}-\d+$/.test(path.basename(stage)), 'RETIREMENT_STAGE_PATH');
    directory(stage, 0o700);
    directory(path.join(stage, 'scripts'), 0o700);
    const bytes = read(path.join(stage, 'contract.json'));
    check(sha256(bytes) === contractSha256, 'RETIREMENT_PACKET_DRIFT');
    const contract = JSON.parse(bytes.toString('utf8')), candidate = read(path.join(stage, 'candidate.flow.json'));
    check(contract.operationSourceSha256 && Object.keys(contract.operationSourceSha256).length === RETIREMENT_SOURCE_FILES.length, 'RETIREMENT_RUNNER_SET');
    for (const relative of RETIREMENT_SOURCE_FILES) {
      const file = path.join(stage, 'scripts', relative);
      directory(path.dirname(file), 0o700);
      check(hex(contract.operationSourceSha256[relative]) && sha256(read(file)) === contract.operationSourceSha256[relative], 'RETIREMENT_RUNNER_DRIFT');
    }
    check(contract.target?.machineIdSha256 === readMachineId(), 'RETIREMENT_MACHINE_DRIFT');
    return { contract, contractBytes: bytes, candidate };
  }
  function ownLease(expectedToken) {
    if (!fs.existsSync(leasePath)) return null;
    const leaseBytes = read(leasePath, [0o600], [1, 2]), lease = JSON.parse(leaseBytes.toString('utf8'));
    check(lease.formatVersion === 2 && lease.phase === 'applying' && lease.kind === 'legacy-startup-retirement' && lease.contractKind === 'legacy-startup-retirement'
      && lease.contractSha256 === contractSha256 && lease.journalPath === journalPath && typeof lease.token === 'string'
      && lease.token.length > 0 && lease.token === expectedToken, 'RETIREMENT_FOREIGN_LEASE');
    // Only a validated matching owner may repair a crash between atomic link/unlink.
    // Foreign leases and every source/candidate artifact remain strict single-link.
    if (fs.lstatSync(leasePath).nlink === 2) recoverAtomicExclusivePublication(leasePath, protectedOptions);
    check(sha256(read(leasePath)) === sha256(leaseBytes), 'RETIREMENT_LEASE_DRIFT');
    return lease;
  }
  function journal(p) {
    directory(backup, 0o700); directory(op, 0o700);
    const j = json(journalPath);
    check(j.formatVersion === 1 && j.contractSha256 === contractSha256 && j.sourceSha256 === p.contract.sourceSha256
      && j.candidateSha256 === p.contract.candidateSha256 && j.deploymentId === p.contract.deploymentId
      && Number.isSafeInteger(j.createdAtMs) && j.createdAtMs >= p.contract.preparedAtMs && j.createdAtMs <= p.contract.validUntilMs
      && j.createdAtMs <= now(), 'RETIREMENT_JOURNAL_DRIFT');
    const source = read(path.join(op, 'source.flow.json')), candidate = read(path.join(op, 'candidate.flow.json'));
    check(sha256(read(path.join(op, 'contract.json'))) === contractSha256 && sha256(candidate) === sha256(p.candidate), 'RETIREMENT_BACKUP_DRIFT');
    validateLegacyRetirementContract({ sourceBytes: source, candidateBytes: candidate, contract: p.contract, bindings });
    return j;
  }
  function save(j, phase, fields = {}) {
    const next = { ...j, ...fields, phase };
    atomicWrite(journalPath, Buffer.from(`${JSON.stringify(next, null, 2)}\n`), { uid, gid });
    onTransition(phase);
    return next;
  }
  function disk(p) {
    const value = sha256(read(live, [0o600, 0o644]));
    return value === p.contract.sourceSha256 ? 'SOURCE' : value === p.contract.candidateSha256 ? 'CANDIDATE' : 'FOREIGN';
  }
  function leaseMatches(p, j) {
    const lease = ownLease(j.leaseToken);
    check(lease && lease.token === j.leaseToken && lease.deploymentId === p.contract.deploymentId
      && lease.sourceSha256 === p.contract.sourceSha256 && lease.candidateSha256 === p.contract.candidateSha256, 'RETIREMENT_LEASE_DRIFT');
    return lease;
  }
  function expectedRuntime(p) {
    const r = pm2.assertOnline();
    check(r.pid === p.contract.target.pid && r.restartCount === p.contract.target.restartCount
      && readRuntimeFingerprint(r.pid) === p.contract.target.runtimeFingerprintSha256, 'RETIREMENT_PROCESS_DRIFT');
    return r;
  }
  function summary(p, j, extra = {}) {
    return { deploymentId: p.contract.deploymentId, contractSha256, sourceSha256: p.contract.sourceSha256,
      candidateSha256: p.contract.candidateSha256, phase: j.phase, sourceRestoreAllowed: false, ...extra };
  }
  function publishAndRestart(p, j) {
    leaseMatches(p, j); const state = disk(p);
    check(['SOURCE', 'CANDIDATE'].includes(state), 'RETIREMENT_FOREIGN_FLOW');
    expectedRuntime(p);
    if (state === 'SOURCE') {
      check(now() >= p.contract.preparedAtMs && now() <= p.contract.validUntilMs, 'RETIREMENT_PACKET_EXPIRED_ABORT_UNPUBLISHED');
      j = save(j, 'PUBLISH_INTENT');
      leaseMatches(p, j); check(disk(p) === 'SOURCE', 'RETIREMENT_FOREIGN_FLOW'); expectedRuntime(p);
      check(now() >= p.contract.preparedAtMs && now() <= p.contract.validUntilMs, 'RETIREMENT_PACKET_EXPIRED_ABORT_UNPUBLISHED');
      atomicWrite(live, p.candidate, { uid, gid });
      onTransition('PUBLISHED_BYTES');
    }
    check(disk(p) === 'CANDIDATE', 'RETIREMENT_PUBLICATION_UNVERIFIED'); leaseMatches(p, j);
    const before = expectedRuntime(p);
    j = save(j, 'RESTART_INTENT', { restartBefore: before });
    check(disk(p) === 'CANDIDATE', 'RETIREMENT_FOREIGN_FLOW'); leaseMatches(p, j); expectedRuntime(p);
    // An exception leaves the durable intent and non-expiring lease in place.
    // No catch block can restore source or automatically replay this restart.
    const after = pm2.restart(before.restartCount);
    check(after.status === 'online' && after.pid > 0 && after.pid !== before.pid && after.restartCount === before.restartCount + 1
      && readRuntimeFingerprint(after.pid) === p.contract.target.runtimeFingerprintSha256, 'RETIREMENT_RESTART_UNVERIFIED');
    check(disk(p) === 'CANDIDATE', 'RETIREMENT_FOREIGN_FLOW'); leaseMatches(p, j);
    j = save(j, 'SOAKING', { restartAfter: after, soakStartedAtMs: now() });
    return summary(p, j, { runtimeVerified: false, leaseRetained: true });
  }
  function release(p, j, phase) {
    leaseMatches(p, j); check(disk(p) === (phase === 'ABORTED' ? 'SOURCE' : 'CANDIDATE'), 'RETIREMENT_FOREIGN_FLOW');
    const result = save(j, phase);
    check(disk(p) === (phase === 'ABORTED' ? 'SOURCE' : 'CANDIDATE'), 'RETIREMENT_FOREIGN_FLOW');
    if (phase === 'ABORTED') expectedRuntime(p);
    else {
      const r = pm2.assertOnline();
      check(r.pid === j.restartAfter.pid && r.restartCount === j.restartAfter.restartCount
        && readRuntimeFingerprint(r.pid) === p.contract.target.runtimeFingerprintSha256, 'RETIREMENT_PROCESS_DRIFT');
    }
    leaseMatches(p, result);
    if (phase === 'COMPLETE') {
      const proof = observation(p, result, pm2.assertOnline());
      check(proof.sha256 === result.postcheckSha256 && now() - proof.observedAtMs <= 30000, 'RETIREMENT_POSTCHECK_UNVERIFIED');
    }
    fs.unlinkSync(leasePath); syncDirectory(stageParent);
    return summary(p, result, { leaseReleased: true });
  }
  function observation(p, j, r) {
    const content = read(path.join(op, 'postcheck.json')), value = JSON.parse(content.toString('utf8'));
    check(now() >= j.soakStartedAtMs + SOAK_MS && Number.isSafeInteger(value.observedAtMs)
      && value.observedAtMs >= j.soakStartedAtMs + SOAK_MS && value.observedAtMs <= now()
      && now() - value.observedAtMs <= 30000 && value.contractSha256 === contractSha256
      && value.readiness === 'ready' && value.pid === r.pid && value.restartCount === r.restartCount
      && canonicalFlowSha256(value.runtimeFlow) === p.contract.candidateCanonicalSha256, 'RETIREMENT_POSTCHECK_UNVERIFIED');
    return { sha256: sha256(content), observedAtMs: value.observedAtMs };
  }
  return {
    preflight() {
      const p = packet(); check(!fs.existsSync(leasePath), 'RETIREMENT_ACTIVE_LEASE');
      check(!fs.existsSync(op), 'RETIREMENT_EXISTING_ATTEMPT_USE_STATUS');
      check(now() >= p.contract.preparedAtMs && now() <= p.contract.validUntilMs, 'RETIREMENT_PACKET_EXPIRED');
      const source = read(live, [0o600, 0o644]);
      validateLegacyRetirementContract({ sourceBytes: source, candidateBytes: p.candidate, contract: p.contract, bindings });
      expectedRuntime(p);
      return summary(p, { phase: 'NOT_STARTED' }, { removedNodeCount: p.contract.removed.length, readOnly: true });
    },
    apply() {
      this.preflight(); const p = packet();
      // Pin a valid attempt start before slow backup/fsync work. Expiry during
      // preparation must still leave an unpublished attempt that can be aborted.
      const startedAtMs = now();
      check(startedAtMs >= p.contract.preparedAtMs && startedAtMs <= p.contract.validUntilMs, 'RETIREMENT_PACKET_EXPIRED');
      if (!fs.existsSync(backup)) { fs.mkdirSync(backup, { mode: 0o700 }); syncDirectory(stageParent); }
      directory(backup, 0o700); fs.mkdirSync(op, { mode: 0o700 }); syncDirectory(backup);
      const source = read(live, [0o600, 0o644]);
      validateLegacyRetirementContract({ sourceBytes: source, candidateBytes: p.candidate, contract: p.contract, bindings });
      exclusive(path.join(op, 'source.flow.json'), source); exclusive(path.join(op, 'candidate.flow.json'), p.candidate);
      exclusive(path.join(op, 'contract.json'), p.contractBytes);
      const j = { formatVersion: 1, phase: 'PREPARED', deploymentId: p.contract.deploymentId, contractSha256,
        sourceSha256: p.contract.sourceSha256, candidateSha256: p.contract.candidateSha256, leaseToken: randomUUID(), createdAtMs: startedAtMs };
      exclusive(journalPath, j); onTransition('PREPARED');
      const lease = { formatVersion: 2, phase: 'applying', kind: 'legacy-startup-retirement', contractKind: 'legacy-startup-retirement', journalPath,
        deploymentId: j.deploymentId, contractSha256, token: j.leaseToken, sourceSha256: j.sourceSha256,
        candidateSha256: j.candidateSha256, acquiredAtMs: now(), expiresAtMs: now() + SOAK_MS };
      writeFileExclusiveAtomicDurable(leasePath, Buffer.from(`${JSON.stringify(lease, null, 2)}\n`), protectedOptions);
      onTransition('LEASED');
      return publishAndRestart(p, j);
    },
    recover() {
      const p = packet(); let j = journal(p); leaseMatches(p, j);
      check(disk(p) !== 'FOREIGN', 'RETIREMENT_FOREIGN_FLOW');
      if (['PREPARED', 'PUBLISH_INTENT'].includes(j.phase)) return publishAndRestart(p, j);
      check(disk(p) === 'CANDIDATE', 'RETIREMENT_SOURCE_RETURNED_OWNER_DECISION');
      if (j.phase === 'RESTART_INTENT') {
        check(disk(p) === 'CANDIDATE', 'RETIREMENT_FOREIGN_FLOW');
        const r = pm2.assertOnline();
        check(j.restartBefore && r.pid !== j.restartBefore.pid && r.restartCount === j.restartBefore.restartCount + 1
          && readRuntimeFingerprint(r.pid) === p.contract.target.runtimeFingerprintSha256, 'RETIREMENT_RESTART_OUTCOME_UNKNOWN_OWNER_DECISION');
        j = save(j, 'SOAKING', { restartAfter: r, soakStartedAtMs: now() });
      }
      check(j.phase === 'SOAKING', 'RETIREMENT_RECOVERY_PHASE');
      const r = pm2.assertOnline();
      check(r.pid === j.restartAfter.pid && r.restartCount === j.restartAfter.restartCount
        && readRuntimeFingerprint(r.pid) === p.contract.target.runtimeFingerprintSha256, 'RETIREMENT_PROCESS_DRIFT');
      return summary(p, j, { runtimeVerified: false, restartReplayed: false, leaseRetained: true });
    },
    finish() {
      const p = packet(); const j = journal(p);
      check(['SOAKING', 'COMPLETE'].includes(j.phase) && disk(p) === 'CANDIDATE', 'RETIREMENT_FINISH_STATE');
      const r = pm2.assertOnline();
      check(r.pid === j.restartAfter.pid && r.restartCount === j.restartAfter.restartCount
        && readRuntimeFingerprint(r.pid) === p.contract.target.runtimeFingerprintSha256, 'RETIREMENT_PROCESS_DRIFT');
      if (j.phase === 'COMPLETE') {
        if (fs.existsSync(leasePath)) {
          leaseMatches(p, j); const proof = observation(p, j, r);
          return release(p, { ...j, postcheckSha256: proof.sha256 }, 'COMPLETE');
        }
        check(hex(j.postcheckSha256) && sha256(read(path.join(op, 'postcheck.json'))) === j.postcheckSha256, 'RETIREMENT_COMPLETION_RECEIPT_DRIFT');
        return summary(p, j, { leaseReleased: true, resumed: true });
      }
      leaseMatches(p, j);
      const proof = observation(p, j, r);
      check(disk(p) === 'CANDIDATE', 'RETIREMENT_FOREIGN_FLOW'); leaseMatches(p, j);
      const finalRuntime = pm2.assertOnline();
      check(finalRuntime.pid === r.pid && finalRuntime.restartCount === r.restartCount
        && readRuntimeFingerprint(finalRuntime.pid) === p.contract.target.runtimeFingerprintSha256, 'RETIREMENT_PROCESS_DRIFT');
      return release(p, { ...j, postcheckSha256: proof.sha256 }, 'COMPLETE');
    },
    abortBeforePublication() {
      const p = packet(), j = journal(p);
      check(['PREPARED', 'PUBLISH_INTENT', 'ABORTED'].includes(j.phase) && disk(p) === 'SOURCE', 'RETIREMENT_ABORT_FORBIDDEN');
      expectedRuntime(p);
      if (!fs.existsSync(leasePath)) { save(j, 'ABORTED'); return summary(p, { phase: 'ABORTED' }, { leaseReleased: true }); }
      return release(p, j, 'ABORTED');
    },
    status() {
      const p = packet(), j = fs.existsSync(journalPath) ? journal(p) : { phase: 'NOT_STARTED' };
      const r = pm2.inspect();
      return summary(p, j, { diskState: disk(p), nodeRedOnline: r.status === 'online', nodeRedPid: r.pid, nodeRedRestartCount: r.restartCount, readOnly: true });
    },
  };
}

export function validateLegacyRetirementCli(args, { uid = process.getuid?.(), self = fileURLToPath(import.meta.url) } = {}) {
  const [action, stage, contractSha256, authorization] = args;
  check(uid === 0 && ['preflight', 'apply', 'status', 'recover', 'finish', 'abort-before-publication'].includes(action), 'RETIREMENT_CLI');
  const readOnly = ['preflight', 'status'].includes(action);
  check(args.length === (readOnly ? 3 : 4) && hex(contractSha256), 'RETIREMENT_CLI_ARGUMENTS');
  if (!readOnly) check(authorization === AUTHORIZE, 'RETIREMENT_AUTHORIZATION_REQUIRED');
  check(typeof stage === 'string' && path.dirname(stage) === ROOT
    && /^\.padlhub-reviewed-flow-stage-\d{8}T\d{6}[+-]\d{4}-\d+$/.test(path.basename(stage))
    && path.join(stage, 'scripts/nodered_reviewed_flow_deploy/legacy_retirement_operation.mjs') === self, 'RETIREMENT_RUN_FROM_REVIEWED_STAGE');
  return { action, stage, contractSha256 };
}

// This worker is reached by the CLI only through a child of flock. There is no
// environment variable that can accidentally skip CLI serialization.
export function runLegacyRetirementWorker(args) {
  const { action, stage, contractSha256 } = validateLegacyRetirementCli(args);
  const operation = createLegacyRetirementOperation({ stage, contractSha256 });
  const method = action === 'abort-before-publication' ? 'abortBeforePublication' : action;
  process.stdout.write(`${JSON.stringify(operation[method]())}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2); validateLegacyRetirementCli(args);
    const fd = fs.openSync(LOCK, fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    try { const s = fs.fstatSync(fd); check(s.isFile() && s.nlink === 1 && s.uid === 0 && (s.mode & 0o777) === 0o600, 'RETIREMENT_LOCK_CUSTODY'); }
    finally { fs.closeSync(fd); }
    const worker = `import {runLegacyRetirementWorker} from ${JSON.stringify(import.meta.url)}; try { runLegacyRetirementWorker(JSON.parse(process.argv[1])); } catch { process.stderr.write('RETIREMENT_REFUSED_USE_STATUS_AND_OWNER_REVIEW\\n'); process.exitCode=1; }`;
    const r = spawnSync('flock', ['-E', '75', '-n', LOCK, process.execPath, '--input-type=module', '-e', worker, JSON.stringify(args)], { stdio: 'inherit' });
    check(!r.error && Number.isInteger(r.status), 'RETIREMENT_LOCK_FAILED'); process.exitCode = r.status;
  } catch { process.stderr.write('RETIREMENT_REFUSED_USE_STATUS_AND_OWNER_REVIEW\n'); process.exitCode = 1; }
}
