import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { atomicWrite, syncDirectory, writeFileExclusiveDurable } from './runtime_contract.mjs';

const KIND = 'support-media-adapter-install';
const NAME = 'node-red-contrib-padlhub-max-outbox-1.1.0.tgz';
const encode = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const sha = value => createHash('sha256').update(value).digest('hex');
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const need = (value, code) => { if (!value) throw Error(code); };
const digests = value => value && Object.keys(value).length > 0
  && Object.entries(value).every(([key, hash]) => /^[A-Za-z][A-Za-z0-9]*$/.test(key) && hex(hash));

export function supportAdapterCustodyCodeHash() {
  return sha(Buffer.concat(['support_photos_adapter_custody.mjs', 'support_photos_adapter_upload_guard.mjs', 'runtime_contract.mjs']
    .map(file => fs.readFileSync(new URL(file, import.meta.url)))));
}

/**
 * Filesystem custody only; never calls npm, HTTP, a provider or a service manager.
 * The pinned operator supplies real process/flow, inventory and mutex readers.
 * A lost operator retains a persistent v4 lease; no clock can release it.
 */
export function createSupportAdapterCustody({ root = '/root/.node-red', stage, backupStage, uid = 0, gid = 0,
  getUid = () => process.getuid(), now = () => Date.now(), assertExclusive, readTarget, readPreimage, readPostimage, installerIdle }) {
  const protection = { uid, gid, mode: 0o600 };
  need([assertExclusive, readTarget, readPreimage, readPostimage, installerIdle].every(fn => typeof fn === 'function'), 'ADAPTER_READERS_REQUIRED');
  const privateDirectory = (directory, privateOnly = true) => {
    const st = fs.lstatSync(directory);
    need(st.isDirectory() && !st.isSymbolicLink() && st.uid === uid && st.gid === gid
      && (privateOnly ? (st.mode & 0o777) === 0o700 : !(st.mode & 0o022))
      && fs.realpathSync(directory) === directory, 'ADAPTER_DIRECTORY_CUSTODY');
  };
  const enter = () => {
    need(getUid() === uid && assertExclusive() === true, 'ADAPTER_EXCLUSIVE_CUSTODY');
    privateDirectory(root, false); privateDirectory(stage); privateDirectory(backupStage);
    need(path.dirname(stage) === root && /^\.padlhub-support-adapter-stage-\d{8}T\d{6}Z-\d+$/.test(path.basename(stage))
      && backupStage !== root && !backupStage.startsWith(root + path.sep)
      && /^support-adapter-backup-\d{8}T\d{6}Z-\d+$/.test(path.basename(backupStage)), 'ADAPTER_STAGE_SCOPE');
  };
  const read = (file, links = [1]) => {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const st = fs.fstatSync(fd), named = fs.lstatSync(file);
      need(st.isFile() && st.uid === uid && st.gid === gid && (st.mode & 0o777) === 0o600
        && links.includes(st.nlink) && st.size <= 1048576 && st.ino === named.ino && st.dev === named.dev, 'ADAPTER_FILE_CUSTODY');
      const raw = fs.readFileSync(fd); need(raw.length <= 1048576, 'ADAPTER_FILE_LIMIT'); return raw;
    } finally { fs.closeSync(fd); }
  };
  const exists = file => { try { fs.lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
  const pairPaths = name => [path.join(stage, name), path.join(backupStage, name)];
  const anyPair = name => pairPaths(name).some(exists);
  const pair = name => {
    const [a, b] = pairPaths(name).map(file => read(file)); need(a.equals(b), 'ADAPTER_DUAL_COPY_DRIFT'); return a;
  };
  const putPair = (name, raw) => {
    for (const file of pairPaths(name)) {
      if (exists(file)) need(read(file).equals(raw), 'ADAPTER_RECEIPT_DRIFT');
      else writeFileExclusiveDurable(file, raw, protection);
      syncDirectory(path.dirname(file));
    }
    need(pair(name).equals(raw), 'ADAPTER_DUAL_COPY_DRIFT');
  };
  const receipt = (name, value) => putPair(name, encode(value));
  const leasePath = path.join(root, '.padlhub-reviewed-flow-deploy.lease.json');
  const policyPath = path.join(root, '.npmrc');
  const stable = p => { enter(); need(readTarget() === p.targetSha256, 'ADAPTER_TARGET_DRIFT'); };
  const idle = () => need(installerIdle() === true, 'ADAPTER_INSTALLER_NOT_IDLE');
  const pre = p => { stable(p); idle(); need(isDeepStrictEqual(readPreimage(), p.preimage), 'ADAPTER_PREIMAGE_DRIFT'); stable(p); };
  const post = p => { stable(p); idle(); need(isDeepStrictEqual(readPostimage(), p.postimage), 'ADAPTER_POSTIMAGE_DRIFT'); stable(p); idle(); };
  const plan = expected => {
    enter(); const raw = pair('plan.json'), p = JSON.parse(raw);
    need(hex(expected) && sha(raw) === expected && p.kind === KIND && p.stage === stage && p.backupStage === backupStage
      && p.codeSha256 === supportAdapterCustodyCodeHash() && digests(p.preimage) && digests(p.postimage), 'ADAPTER_PLAN_DRIFT');
    const original = pair('predecessor.lease.json'); need(sha(original) === p.predecessor.sha256, 'ADAPTER_PREDECESSOR_BACKUP_DRIFT');
    return { ...p, planSha256: expected };
  };
  const legacy = (raw, p) => {
    const value = JSON.parse(raw);
    need(sha(raw) === p.predecessor.sha256 && value.formatVersion === 2 && value.phase === 'soaking'
      && value.deploymentId === p.predecessor.deploymentId && typeof value.token === 'string' && value.token.trim()
      && Number.isSafeInteger(value.acquiredAtMs) && Number.isSafeInteger(value.expiresAtMs)
      && value.expiresAtMs > value.acquiredAtMs && value.expiresAtMs <= now()
      && hex(value.sourceSha256) && value.candidateSha256 === p.sourceFlowSha256, 'ADAPTER_PREDECESSOR_DRIFT');
  };
  const leaseBytes = (p, phase) => encode({ formatVersion: 4, kind: KIND, deploymentId: p.operationId,
    stage, backupStage, planSha256: p.planSha256, codeSha256: p.codeSha256, operatorSha256: p.operatorSha256,
    targetSha256: p.targetSha256, predecessorSha256: p.predecessor.sha256, sourceSha256: p.sourceFlowSha256,
    artifactSha256: p.artifact.sha256, phase, acquiredAtMs: p.preparedAtMs });
  const owns = p => {
    const raw = read(leasePath), phase = JSON.parse(raw).phase;
    need(['reserved', 'attempted', 'terminal', 'cancelled'].includes(phase) && raw.equals(leaseBytes(p, phase)), 'ADAPTER_FOREIGN_LEASE');
    return phase;
  };
  const phase = (p, value) => { owns(p); atomicWrite(leasePath, leaseBytes(p, value), { uid, gid }); };
  const policyBytes = p => Buffer.from('offline=true\ncache=' + p.cacheDirectory + '\n');
  const policyIntent = p => {
    const value = JSON.parse(pair('policy-intent.json'));
    need(value.planSha256 === p.planSha256 && value.sha256 === sha(policyBytes(p))
      && Number.isSafeInteger(value.inode) && Number.isSafeInteger(value.device), 'ADAPTER_POLICY_INTENT');
    return value;
  };
  const policyOwned = p => {
    const intent = policyIntent(p), raw = read(policyPath, [2]), st = fs.lstatSync(policyPath);
    need(raw.equals(policyBytes(p)) && st.ino === intent.inode && st.dev === intent.device, 'ADAPTER_POLICY_FOREIGN');
    const source = fs.lstatSync(path.join(stage, 'policy-source.npmrc'));
    need(source.ino === st.ino && source.dev === st.dev, 'ADAPTER_POLICY_SOURCE_DRIFT');
  };
  const unpublishedPolicy = (p, outcomeSha256) => {
    const cancelled = JSON.parse(pair('cancelled.json'));
    need(cancelled.planSha256 === p.planSha256 && !cancelled.audit && !anyPair('attempt.json') && !exists(policyPath),
      'ADAPTER_UNPUBLISHED_POLICY_UNPROVEN');
    pre(p);
    const raw = pair('policy-source.npmrc'), st = fs.lstatSync(path.join(stage, 'policy-source.npmrc'));
    need(raw.equals(policyBytes(p)) && st.nlink === 1, 'ADAPTER_POLICY_SOURCE_DRIFT');
    const intent = { planSha256: p.planSha256, sha256: sha(raw), inode: st.ino, device: st.dev };
    receipt('policy-unpublished.json', { ...intent, outcomeSha256 });
    receipt('policy-intent.json', intent);
    need(!exists(policyPath), 'ADAPTER_POLICY_FOREIGN');
  };
  const attempt = p => {
    const raw = pair('attempt.json'), value = JSON.parse(raw);
    need(value.planSha256 === p.planSha256 && value.fileName === NAME && value.fileSha256 === p.artifact.sha256
      && value.fileSize === p.artifact.size && /^[a-f0-9-]{36}$/.test(value.nonce)
      && Number.isSafeInteger(value.deadline), 'ADAPTER_ATTEMPT_DRIFT');
    return { raw, value };
  };
  const auditCheck = (p, audit) => {
    const { raw, value } = attempt(p);
    need(audit && Object.keys(audit).sort().join(',') === 'attemptSha256,cancelledBeforeForward,fileSha256,forwarded,httpStatus,nonce,planSha256,rejected,terminal'
      && audit.planSha256 === p.planSha256 && audit.attemptSha256 === sha(raw)
      && audit.fileSha256 === p.artifact.sha256 && audit.nonce === value.nonce
      && Number.isSafeInteger(audit.rejected) && audit.rejected >= 0, 'ADAPTER_NATIVE_AUDIT_DRIFT');
  };
  const outcome = p => {
    if (anyPair('terminal.json')) {
      const value = JSON.parse(pair('terminal.json')); auditCheck(p, value.audit);
      need(value.planSha256 === p.planSha256 && value.audit.forwarded === 1 && value.audit.terminal === true
        && value.audit.httpStatus === 200 && value.audit.rejected === 0 && value.audit.cancelledBeforeForward === false,
      'ADAPTER_TERMINAL_REQUIRED');
      post(p); return sha(pair('terminal.json'));
    }
    const value = JSON.parse(pair('cancelled.json'));
    need(value.planSha256 === p.planSha256, 'ADAPTER_CANCEL_DRIFT');
    if (value.audit) {
      auditCheck(p, value.audit);
      need(value.audit.cancelledBeforeForward === true && value.audit.forwarded === 0 && value.audit.httpStatus === null
        && value.audit.terminal === false, 'ADAPTER_CANCEL_NOT_QUIESCENT');
    } else need(!anyPair('attempt.json'), 'ADAPTER_ATTEMPT_CONSUMED');
    pre(p); return sha(pair('cancelled.json'));
  };
  return {
    prepare({ expectedTargetSha256, expectedCodeSha256, operatorSha256, ownerAgreementSha256, expectedPredecessor,
      sourceFlowSha256, artifact, cacheDirectory, preimage, postimage }) {
      enter(); need(!anyPair('plan.json') && hex(expectedTargetSha256) && expectedCodeSha256 === supportAdapterCustodyCodeHash()
        && hex(operatorSha256) && hex(ownerAgreementSha256) && hex(sourceFlowSha256)
        && hex(expectedPredecessor?.sha256) && /^[a-z0-9-]{2,64}$/.test(expectedPredecessor?.deploymentId)
        && hex(artifact?.sha256) && artifact.fileName === NAME && Number.isSafeInteger(artifact.size)
        && artifact.size > 0 && artifact.size <= 262144 && digests(preimage) && digests(postimage), 'ADAPTER_PREPARE_PINS');
      need(typeof cacheDirectory === 'string' && /^\/[A-Za-z0-9._/-]+$/.test(cacheDirectory)
        && !cacheDirectory.split('/').includes('..'), 'ADAPTER_CACHE_PATH'); privateDirectory(cacheDirectory);
      const p = { kind: KIND, formatVersion: 1, stage, backupStage, operationId: 'support-adapter-' + randomUUID(),
        preparedAtMs: now(), codeSha256: expectedCodeSha256, operatorSha256, ownerAgreementSha256,
        targetSha256: expectedTargetSha256, predecessor: structuredClone(expectedPredecessor), sourceFlowSha256,
        artifact: structuredClone(artifact), cacheDirectory, preimage: structuredClone(preimage), postimage: structuredClone(postimage) };
      pre(p); need(!exists(policyPath), 'ADAPTER_POLICY_PREIMAGE_PRESENT');
      const original = read(leasePath); legacy(original, p);
      putPair('predecessor.lease.json', original); receipt('plan.json', p);
      stable(p); need(read(leasePath).equals(original), 'ADAPTER_PREDECESSOR_DRIFT');
      return { status: 'PREPARED', planSha256: sha(pair('plan.json')) };
    },
    reserve({ expectedPlanSha256 }) {
      const p = plan(expectedPlanSha256); pre(p);
      need(now() >= p.preparedAtMs && now() - p.preparedAtMs <= 1800000, 'ADAPTER_PLAN_STALE');
      need(!anyPair('reserve-intent.json') && !exists(policyPath), 'ADAPTER_RESERVE_CONSUMED');
      const raw = read(leasePath); legacy(raw, p);
      receipt('reserve-intent.json', { kind: KIND, planSha256: expectedPlanSha256, predecessorSha256: sha(raw) });
      stable(p); need(sha(read(leasePath)) === p.predecessor.sha256, 'ADAPTER_PREDECESSOR_DRIFT');
      atomicWrite(leasePath, leaseBytes(p, 'reserved'), { uid, gid });
      stable(p); owns(p);
      return { status: 'RESERVED', expiryReleasesCustody: false };
    },
    publishPolicy({ expectedPlanSha256 }) {
      const p = plan(expectedPlanSha256); pre(p); need(owns(p) === 'reserved' && !anyPair('attempt.json'), 'ADAPTER_POLICY_PHASE');
      need(!anyPair('policy-intent.json') && !exists(policyPath), 'ADAPTER_POLICY_PUBLICATION_CONSUMED');
      const raw = policyBytes(p); putPair('policy-source.npmrc', raw);
      const st = fs.lstatSync(path.join(stage, 'policy-source.npmrc'));
      receipt('policy-intent.json', { planSha256: p.planSha256, sha256: sha(raw), inode: st.ino, device: st.dev });
      stable(p); owns(p); need(!exists(policyPath), 'ADAPTER_POLICY_PREIMAGE_PRESENT');
      fs.linkSync(path.join(stage, 'policy-source.npmrc'), policyPath); syncDirectory(root); policyOwned(p);
      return { status: 'OFFLINE_POLICY_READY' };
    },
    begin({ expectedPlanSha256 }) {
      const p = plan(expectedPlanSha256); pre(p); policyOwned(p);
      need(owns(p) === 'reserved' && !anyPair('attempt.json'), 'ADAPTER_ATTEMPT_CONSUMED');
      const value = { planSha256: p.planSha256, fileName: NAME, fileSha256: p.artifact.sha256, fileSize: p.artifact.size,
        nonce: randomUUID(), deadline: now() + 300000 };
      receipt('attempt.json', value); phase(p, 'attempted'); stable(p); policyOwned(p);
      return { ...value, attemptSha256: sha(pair('attempt.json')) };
    },
    confirm({ expectedPlanSha256, audit }) {
      const p = plan(expectedPlanSha256); need(owns(p) === 'attempted' || owns(p) === 'terminal', 'ADAPTER_CONFIRM_PHASE');
      auditCheck(p, audit);
      need(audit.forwarded === 1 && audit.rejected === 0 && audit.terminal === true && audit.httpStatus === 200
        && audit.cancelledBeforeForward === false, 'ADAPTER_TERMINAL_REQUIRED');
      policyOwned(p); post(p);
      receipt('terminal.json', { planSha256: p.planSha256, audit: structuredClone(audit) }); phase(p, 'terminal');
      return { status: 'TERMINAL_VERIFIED' };
    },
    cancel({ expectedPlanSha256, audit }) {
      const p = plan(expectedPlanSha256), current = owns(p); need(['reserved', 'attempted', 'cancelled'].includes(current), 'ADAPTER_CANCEL_PHASE');
      if (anyPair('attempt.json')) {
        auditCheck(p, audit);
        need(audit.cancelledBeforeForward === true && audit.forwarded === 0 && audit.terminal === false
          && audit.httpStatus === null, 'ADAPTER_CANCEL_NOT_QUIESCENT');
      } else need(!audit, 'ADAPTER_CANCEL_AUDIT_WITHOUT_ATTEMPT');
      pre(p); receipt('cancelled.json', { planSha256: p.planSha256, ...(audit ? { audit: structuredClone(audit) } : {}) });
      phase(p, 'cancelled'); return { status: 'CANCELLED_BEFORE_FORWARD' };
    },
    removePolicy({ expectedPlanSha256 }) {
      const p = plan(expectedPlanSha256); owns(p); const outcomeSha256 = outcome(p);
      if (!anyPair('policy-intent.json')) {
        need(!exists(policyPath), 'ADAPTER_POLICY_FOREIGN');
      } else {
        if (!exists(policyPath) && !anyPair('policy-removal-intent.json')) unpublishedPolicy(p, outcomeSha256);
        policyIntent(p);
        const removal = { planSha256: p.planSha256, outcomeSha256, policyIntentSha256: sha(pair('policy-intent.json')) };
        if (exists(policyPath)) {
          policyOwned(p); receipt('policy-removal-intent.json', removal);
          owns(p); policyOwned(p); fs.unlinkSync(policyPath);
        } else {
          receipt('policy-removal-intent.json', removal);
          need(pair('policy-removal-intent.json').equals(encode(removal)), 'ADAPTER_POLICY_MISSING');
        }
      }
      syncDirectory(root); need(!exists(policyPath), 'ADAPTER_POLICY_FOREIGN');
      receipt('policy-removed.json', { planSha256: p.planSha256, outcomeSha256 });
      return { status: 'OWNED_POLICY_REMOVED' };
    },
    handback({ expectedPlanSha256 }) {
      const p = plan(expectedPlanSha256); const outcomeSha256 = outcome(p);
      need(!exists(policyPath), 'ADAPTER_POLICY_STILL_PRESENT');
      need(isDeepStrictEqual(JSON.parse(pair('policy-removed.json')), { planSha256: p.planSha256, outcomeSha256 }), 'ADAPTER_POLICY_RECEIPT_DRIFT');
      const original = pair('predecessor.lease.json'); legacy(original, p);
      const intent = { planSha256: p.planSha256, outcomeSha256, predecessorSha256: p.predecessor.sha256 };
      const current = read(leasePath);
      if (current.equals(original)) {
        need(pair('handback-intent.json').equals(encode(intent)), 'ADAPTER_HAND_BACK_UNPROVEN');
      } else {
        owns(p); receipt('handback-intent.json', intent);
        stable(p); owns(p); atomicWrite(leasePath, original, { uid, gid });
      }
      syncDirectory(root); need(read(leasePath).equals(original), 'ADAPTER_HAND_BACK_DRIFT');
      receipt('handback-complete.json', intent);
      return { status: 'PREDECESSOR_RETURNED', predecessorSha256: p.predecessor.sha256 };
    },
  };
}
