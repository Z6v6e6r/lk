#!/usr/bin/env node
// Separate observed-POST recovery protocol. Never POST, restart, replay, or write
// live flows/old stage. Full native acquisition may take120s; completion stays30s.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sha256 } from '../lib/preview363_activation.mjs';
import { readPreview363Target } from './preview363_native_operation.mjs';
import { preview363GraphHash, preview363OrderedGraphHash } from './preview363_body_preserver.mjs';
import { atomicWrite, writeFileExclusiveDurable, syncDirectory, validateReviewedFlowContract } from './runtime_contract.mjs';

const ROOT = '/root/.node-red', LEASE = '.padlhub-reviewed-flow-deploy.lease.json';
const KIND = 'preview363-observed-post-recovery-v1', OLD_KIND = 'preview363-native-nodes', SOAK = 900000;
const OLD_FILES = ['preview363_native_operation.mjs', 'preview363_body_preserver.mjs', 'preview363_browser_guard.mjs',
  'runtime_contract.mjs', '../lib/preview363_activation.mjs', '../lib/preview363_body_patch.mjs', '../diagnostics/preview-empty-tariff-observer.bundle.cjs'];
const check = (ok, code) => { if (!ok) throw Error(code); };
const hex = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const bytes = x => Buffer.from(JSON.stringify(x, null, 2) + '\n');
const codeFiles = [...OLD_FILES, 'preview363_observed_recovery.mjs', 'preview363_recovery_observe.py'];
export const recoveryCodeHash = () => sha256(Buffer.concat(codeFiles.map(n => fs.readFileSync(new URL(n, import.meta.url)))));
const manifestKeys = ['kind','oldStage','oldPlanSha256','oldAttemptSha256','oldCodeSha256','sourceSha256','candidateSha256',
  'postDiskSha256','targetSha256','revisionSha256','candidateGraphSha256','candidateOrderedGraphSha256','editorOrderedGraphSha256',
  'afterFunctionSha256','settingsSha256','sourceCommit','bundleSha256','actualAckAtMs','recoveryCodeSha256'];

export function createObservedRecovery({ stage, root = ROOT, uid = 0, gid = 0, now = Date.now,
  readTarget = readPreview363Target, codeHash = recoveryCodeHash, observe, fault = () => {} } = {}) {
  const protection = { uid, gid, mode: 0o600 };
  const directory = (p, pattern) => {
    const st = fs.lstatSync(p);
    check(path.dirname(p) === root && pattern.test(path.basename(p)) && st.isDirectory() && !st.isSymbolicLink()
      && fs.realpathSync(p) === p && st.uid === uid && st.gid === gid && (st.mode & 0o777) === 0o700, 'R363_DIRECTORY');
  };
  directory(stage, /^\.padlhub-preview363-recovery-\d{8}T\d{6}Z-\d+$/);
  const read = (name, modes = [0o600]) => {
    const fd = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const a = fs.fstatSync(fd), b = fs.lstatSync(name);
      check(a.isFile() && a.nlink === 1 && a.uid === uid && a.gid === gid && modes.includes(a.mode & 0o777)
        && a.ino === b.ino && a.dev === b.dev, 'R363_FILE');
      return fs.readFileSync(fd);
    } finally { fs.closeSync(fd); }
  };
  const local = n => path.join(stage, n), leasePath = path.join(root, LEASE);
  const write = (n, v) => writeFileExclusiveDurable(local(n), bytes(v), protection);
  const json = p => JSON.parse(read(p));
  const manifestRaw = read(local('recovery-manifest.json')), m = JSON.parse(manifestRaw), manifestSha = sha256(manifestRaw);
  check(Object.keys(m).sort().join(',') === [...manifestKeys].sort().join(',') && m.kind === KIND
    && manifestKeys.filter(k => k.endsWith('Sha256')).every(k => hex(m[k]))
    && /^[a-f0-9]{40}$/.test(m.sourceCommit) && Number.isSafeInteger(m.actualAckAtMs) && m.actualAckAtMs > 0
    && m.recoveryCodeSha256 === codeHash(), 'R363_MANIFEST');
  directory(m.oldStage, /^\.padlhub-preview363-stage-\d{8}T\d{6}Z-\d+$/);
  const old = n => path.join(m.oldStage, n);
  const lease = () => fs.existsSync(leasePath) ? json(leasePath) : null;
  const owns = l => check(l?.formatVersion === 5 && l.kind === OLD_KIND && l.stage === m.oldStage
    && l.planSha256 === m.oldPlanSha256 && l.codeSha256 === m.oldCodeSha256 && l.targetSha256 === m.targetSha256
    && l.sourceSha256 === m.sourceSha256 && l.candidateSha256 === m.candidateSha256, 'R363_OWN_LEASE');
  const recoveryOwns = l => {
    owns(l); check(l.phase === 'recovery-soaking' && l.recoveryStage === stage
      && l.recoveryCodeSha256 === m.recoveryCodeSha256 && l.recoveryManifestSha256 === manifestSha, 'R363_RECOVERY_LEASE');
  };
  const freshAtPublication = native => {
    const current = now(), start = Date.parse(native.requestedAt), end = Date.parse(native.observedAt);
    check(start <= end && end <= current && current - start <= 120000 && current - end <= 30000, 'R363_PUBLICATION_FRESHNESS');
  };
  const stable = async native => {
    check(codeHash() === m.recoveryCodeSha256, 'R363_NEW_CODE_DRIFT');
    const oldCode = Buffer.concat(OLD_FILES.map(n => read(old('scripts/nodered_reviewed_flow_deploy/' + n))));
    check(sha256(oldCode) === m.oldCodeSha256, 'R363_OLD_CODE_DRIFT');
    check(sha256(read(old('scripts/diagnostics/preview-empty-tariff-observer.bundle.cjs'))) === m.bundleSha256, 'R363_BUNDLE_DRIFT');
    const planRaw = read(old('plan.json')), attemptRaw = read(old('attempt.json'));
    check(sha256(planRaw) === m.oldPlanSha256 && sha256(attemptRaw) === m.oldAttemptSha256, 'R363_OLD_RECORD_DRIFT');
    const p = JSON.parse(planRaw), a = JSON.parse(attemptRaw);
    check(p.kind === OLD_KIND && p.formatVersion === 2 && p.codeSha256 === m.oldCodeSha256
      && p.sourceSha256 === m.sourceSha256 && p.candidateSha256 === m.candidateSha256 && p.targetSha256 === m.targetSha256
      && p.sourceCommit === m.sourceCommit && p.candidateGraphSha256 === m.candidateGraphSha256
      && p.candidateOrderedGraphSha256 === m.candidateOrderedGraphSha256 && p.editorOrderedGraphSha256 === m.editorOrderedGraphSha256
      && p.afterFunctionSha256 === m.afterFunctionSha256 && a.planSha256 === m.oldPlanSha256
      && a.preRevisionSha256 === p.preRevisionSha256 && m.actualAckAtMs >= a.requestedAtMs
      && m.actualAckAtMs <= now() && m.revisionSha256 !== p.preRevisionSha256, 'R363_OLD_BINDING');
    const source = read(old('source.flow.json')), candidate = read(old('candidate.flow.json'));
    check(sha256(source) === m.sourceSha256 && sha256(candidate) === m.candidateSha256, 'R363_BACKUP_DRIFT');
    validateReviewedFlowContract({ liveBytes: source, candidateBytes: candidate, contract: p.contract });
    check(p.contract.allowedChanges.length === 1 && p.contract.allowedChanges[0].id === 'lk_subscription_price_preview_20260908_router'
      && p.contract.allowedChanges[0].fields.join(',') === 'func' && p.contract.allowedAdditions.length === 0, 'R363_SCOPE');
    const live = read(path.join(root, 'flows.json'), [0o600, 0o644]), graph = JSON.parse(live);
    check(sha256(live) === m.postDiskSha256 && await preview363GraphHash(graph) === m.candidateGraphSha256
      && await preview363OrderedGraphHash(graph) === m.candidateOrderedGraphSha256
      && await preview363GraphHash(JSON.parse(candidate)) === m.candidateGraphSha256
      && await preview363OrderedGraphHash(JSON.parse(candidate)) === m.candidateOrderedGraphSha256
      && readTarget() === m.targetSha256, 'R363_CURRENT_DRIFT');
    const keys = ['origin','requestedAt','observedAt','revisionSha256','graphSha256','orderedGraphSha256','editorOrderedGraphSha256'];
    check(native && Object.keys(native).sort().join(',') === keys.sort().join(','), 'R363_NATIVE_SHAPE');
    const start = Date.parse(native.requestedAt), end = Date.parse(native.observedAt), current = now();
    check(Number.isFinite(start) && Number.isFinite(end) && new Date(start).toISOString() === native.requestedAt
      && new Date(end).toISOString() === native.observedAt && start >= m.actualAckAtMs && start <= end && end <= current
      && current - start <= 120000 && current - end <= 30000 && native.origin === 'http://127.0.0.1:18801'
      && native.revisionSha256 === m.revisionSha256 && native.graphSha256 === m.candidateGraphSha256
      && native.orderedGraphSha256 === m.candidateOrderedGraphSha256
      && native.editorOrderedGraphSha256 === m.editorOrderedGraphSha256, 'R363_NATIVE_EVIDENCE');
    const o = observe ? observe() : JSON.parse(execFileSync('python3', [fileURLToPath(new URL('preview363_recovery_observe.py', import.meta.url)), m.oldStage, 'observe'],
      { encoding: 'utf8', timeout: 15000, stdio: ['ignore','pipe','pipe'] }));
    const observed = Date.parse(o.at);
    check(o.status === 'SAFE_LOG_OBSERVATION' && observed <= now() && now() - observed <= 30000
      && o.samePid === true && o.sameRestartCount === true && o.coverageComplete === true && o.readyExpected === 1
      && o.unavailable === 0 && o.routerRuntimeErrors === 0 && o.malformedEnvelopes === 0
      && o.sourceStableDuringObservation === true && o.sourceSha256 === m.postDiskSha256
      && o.functionSha256 === m.afterFunctionSha256 && o.settingsSha256 === m.settingsSha256, 'R363_RUNTIME_EVIDENCE');
    check(sha256(read(path.join(root,'flows.json'), [0o600,0o644])) === m.postDiskSha256 && readTarget() === m.targetSha256
      && now() - start <= 120000 && now() - end <= 30000, 'R363_FINAL_DRIFT');
  };
  const adoption = () => {
    const raw = read(local('adoption.json')), r = JSON.parse(raw);
    check(r.kind === KIND && r.mode === 'observed-post-adoption' && r.manifestSha256 === manifestSha
      && r.recoveryCodeSha256 === m.recoveryCodeSha256 && r.oldPlanSha256 === m.oldPlanSha256
      && r.oldAttemptSha256 === m.oldAttemptSha256 && Number.isSafeInteger(r.adoptedAtMs)
      && r.soakUntilMs === r.adoptedAtMs + SOAK && r.adoptedAtMs >= m.actualAckAtMs, 'R363_ADOPTION_RECORD');
    return { raw, r };
  };
  return {
    async adopt({ expectedManifestSha256, confirmation, native }) {
      check(expectedManifestSha256 === manifestSha && confirmation === 'ADOPT_COMPLETE_PREVIEW363_POST_RECOVERY_NO_REPLAY_147', 'R363_AUTHORITY');
      const l = lease(); owns(l);
      if (l.phase === 'recovery-soaking') recoveryOwns(l);
      else check(['reserved','owner-decision'].includes(l.phase), 'R363_PHASE');
      check(!['ack.json','finish.json','rollback-reserve.json','rollback-attempt.json','rollback-ack.json','rollback-finish.json','abort.json']
        .some(n => fs.existsSync(old(n))), 'R363_LEGACY_TRANSITION');
      await stable(native);
      if (!fs.existsSync(local('adoption.json'))) {
        const adoptedAtMs = now();
        write('adoption.json', { kind: KIND, mode: 'observed-post-adoption',
          manifestSha256: manifestSha, recoveryCodeSha256: m.recoveryCodeSha256, oldPlanSha256: m.oldPlanSha256,
          oldAttemptSha256: m.oldAttemptSha256, adoptedAtMs, soakUntilMs: adoptedAtMs + SOAK, native });
      }
      const { raw, r } = adoption();
      if (l.phase === 'recovery-soaking') check(l.recoveryAdoptionSha256 === sha256(raw)
        && l.acquiredAtMs === r.adoptedAtMs && l.expiresAtMs === r.soakUntilMs, 'R363_SOAK_DRIFT');
      fault('after-adoption'); check(JSON.stringify(lease()) === JSON.stringify(l), 'R363_LEASE_DRIFT');
      check(sha256(read(path.join(root,'flows.json'), [0o600,0o644])) === m.postDiskSha256 && readTarget() === m.targetSha256, 'R363_FINAL_DRIFT');
      freshAtPublication(native);
      atomicWrite(leasePath, bytes({ ...l, phase: 'recovery-soaking', recoveryStage: stage,
        recoveryCodeSha256: m.recoveryCodeSha256, recoveryManifestSha256: manifestSha, recoveryAdoptionSha256: sha256(raw),
        acquiredAtMs: r.adoptedAtMs, expiresAtMs: r.soakUntilMs }), { uid, gid });
      return { status: 'RECOVERY_SOAKING', mode: r.mode, soakUntil: new Date(r.soakUntilMs).toISOString(), liveFlowWritten: false };
    },
    async finish({ expectedManifestSha256, native }) {
      check(expectedManifestSha256 === manifestSha, 'R363_AUTHORITY');
      const l = lease(), { raw, r } = adoption(), exists = fs.existsSync(local('finish.json'));
      if (l) { recoveryOwns(l); check(l.recoveryAdoptionSha256 === sha256(raw) && l.acquiredAtMs === r.adoptedAtMs
        && l.expiresAtMs === r.soakUntilMs, 'R363_SOAK_DRIFT'); }
      else check(exists, 'R363_LEASE_ABSENT');
      check(now() >= r.soakUntilMs && Date.parse(native?.requestedAt) >= r.soakUntilMs, 'R363_SOAK_INCOMPLETE');
      await stable(native);
      const receipt = { kind: KIND, manifestSha256: manifestSha, adoptionSha256: sha256(raw),
        diskSha256: m.postDiskSha256, revisionSha256: m.revisionSha256, targetSha256: m.targetSha256 };
      if (exists) check(JSON.stringify(json(local('finish.json'))) === JSON.stringify(receipt), 'R363_FINISH_DRIFT');
      else write('finish.json', receipt);
      fault('after-finish');
      if (l) { const current = lease(); recoveryOwns(current); check(JSON.stringify(current) === JSON.stringify(l), 'R363_LEASE_DRIFT');
        check(sha256(read(path.join(root,'flows.json'), [0o600,0o644])) === m.postDiskSha256 && readTarget() === m.targetSha256, 'R363_FINAL_DRIFT');
        freshAtPublication(native);
        fs.unlinkSync(leasePath); syncDirectory(root); }
      return { status: 'RECOVERY_FINISHED', leaseReleased: true, liveFlowWritten: false, nodeRedRestarted: false };
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    check(process.getuid() === 0 && process.argv.length === 4 && ['adopt','finish'].includes(process.argv[2]), 'R363_CLI');
    if (process.env.PADLHUB_PREVIEW363_RECOVERY_LOCK_HELD !== '1') {
      const lock = path.join(ROOT,'.padlhub-reviewed-flow-deploy.lock');
      const st = fs.lstatSync(lock); check(st.isFile() && !st.isSymbolicLink() && st.uid === 0 && st.nlink === 1 && (st.mode & 0o777) === 0o600, 'R363_LOCK');
      const result = spawnSync('flock',['-E','75','-n',lock,process.execPath,fileURLToPath(import.meta.url),...process.argv.slice(2)],
        { env: { ...process.env, PADLHUB_PREVIEW363_RECOVERY_LOCK_HELD:'1' }, stdio:'inherit',timeout:60000 });
      check(!result.error && Number.isInteger(result.status),'R363_LOCK'); process.exitCode = result.status;
    } else {
      const op = createObservedRecovery({stage:process.argv[3]});
      console.log(JSON.stringify(await op[process.argv[2]](JSON.parse(fs.readFileSync(0,'utf8')))));
    }
  } catch { console.error('Observed recovery refused; preserve old/new stages and sticky lease'); process.exitCode = 1; }
}
