#!/usr/bin/env node
// Root custody for one original, authenticated native-editor request. This file
// never calls /flows, writes flows.json, reads tokens or restarts a process.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { patchPreview363Flow, buildPreview363Artifact, sha256, PREVIEW363_FLOW_SHA } from '../lib/preview363_activation.mjs';
import { buildExactGraphContract, validateReviewedFlowContract, writeFileExclusiveDurable,
  writeFileExclusiveAtomicDurable, recoverAtomicExclusivePublication, atomicWrite, syncDirectory } from './runtime_contract.mjs';
import { preview363GraphHash, preview363OrderedGraphHash } from './preview363_body_preserver.mjs';
import { buildPreview363BrowserGuard } from './preview363_browser_guard.mjs';

const ROOT = '/root/.node-red', LEASE = '.padlhub-reviewed-flow-deploy.lease.json';
const KIND = 'preview363-native-nodes', SOAK = 900000;
const hex = s => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
const check = (ok, code) => { if (!ok) throw new Error(code); };
const bytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
export function preview363OperationCodeHash() {
  return sha256(Buffer.concat(['preview363_native_operation.mjs', 'preview363_body_preserver.mjs',
    'preview363_browser_guard.mjs', 'runtime_contract.mjs', '../lib/preview363_activation.mjs', '../lib/preview363_body_patch.mjs', '../diagnostics/preview-empty-tariff-observer.bundle.cjs']
    .map(name => fs.readFileSync(new URL(name, import.meta.url)))));
}
export function readPreview363Target() {
  const list = JSON.parse(execFileSync('pm2', ['jlist'], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }));
  const found = list.filter(p => p.name === 'node-red'); check(found.length === 1, 'P363_PROCESS');
  const p = found[0], env = p.pm2_env;
  check(env.status === 'online' && Number.isSafeInteger(p.pid) && p.pid > 0
    && Number.isSafeInteger(env.restart_time) && fs.statSync(`/proc/${p.pid}`).uid === 0, 'P363_PROCESS_OWNER');
  const listeners = execFileSync('ss', ['-ltnpH'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] })
    .split('\n').filter(l => /:1880\s/.test(l));
  check(listeners.length === 1 && listeners[0].includes(`pid=${p.pid},`), 'P363_LISTENER_OWNER');
  const settings = `${ROOT}/settings.js`, st = fs.lstatSync(settings);
  check(st.isFile() && !st.isSymbolicLink() && st.uid === 0 && st.nlink === 1 && !(st.mode & 0o022), 'P363_SETTINGS');
  const entry = fs.realpathSync(env.pm_exec_path), version = JSON.parse(fs.readFileSync(path.join(path.dirname(entry), 'package.json'))).version;
  check(version === '4.0.9', 'P363_RUNTIME_VERSION');
  return sha256(bytes({ machine: sha256(fs.readFileSync('/etc/machine-id')), pid: p.pid, restarts: env.restart_time,
    executable: fs.readlinkSync(`/proc/${p.pid}/exe`), cwd: fs.readlinkSync(`/proc/${p.pid}/cwd`),
    command: sha256(fs.readFileSync(`/proc/${p.pid}/cmdline`)), entry, settings: sha256(fs.readFileSync(settings)), version }));
}

export function createPreview363NativeOperation({ stage, root = ROOT, uid = 0, gid = 0,
  getUid = () => process.getuid(), now = Date.now, readTarget = readPreview363Target,
  codeHash = preview363OperationCodeHash, patchOptions = {} } = {}) {
  const protection = { uid, gid, mode: 0o600 };
  check(getUid() === uid && path.dirname(stage) === root
    && /^\.padlhub-preview363-stage-\d{8}T\d{6}Z-\d+$/.test(path.basename(stage)), 'P363_STAGE_PATH');
  const dir = fs.lstatSync(stage);
  check(dir.isDirectory() && !dir.isSymbolicLink() && fs.realpathSync(stage) === stage
    && dir.uid === uid && dir.gid === gid && (dir.mode & 0o777) === 0o700, 'P363_STAGE_CUSTODY');
  const file = name => path.join(stage, name), leasePath = path.join(root, LEASE);
  const read = (name, modes = [0o600], links = [1]) => {
    const fd = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const st = fs.fstatSync(fd), link = fs.lstatSync(name);
      check(st.isFile() && links.includes(st.nlink) && st.uid === uid && st.gid === gid && modes.includes(st.mode & 0o777)
        && st.ino === link.ino && st.dev === link.dev, 'P363_FILE_CUSTODY');
      return fs.readFileSync(fd);
    } finally { fs.closeSync(fd); }
  };
  const live = () => read(path.join(root, 'flows.json'), [0o600, 0o644]);
  const json = name => JSON.parse(read(file(name)));
  const write = (name, value) => writeFileExclusiveDurable(file(name), bytes(value), protection);
  const readLease = () => {
    if (!fs.existsSync(leasePath)) return null;
    if (fs.lstatSync(leasePath).nlink === 2) {
      const value = JSON.parse(read(leasePath, [0o600], [2]));
      check(value.formatVersion === 5 && value.kind === KIND && value.stage === stage, 'P363_FOREIGN_PARTIAL_LEASE');
      recoverAtomicExclusivePublication(leasePath, protection);
    }
    const value = JSON.parse(read(leasePath));
    if (value.formatVersion === 2) check(typeof value.deploymentId === 'string'
      && /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/.test(value.deploymentId)
      && typeof value.token === 'string' && value.token.trim().length > 0
      && ['applying', 'soaking', 'rollback-restart-required'].includes(value.phase)
      && Number.isSafeInteger(value.acquiredAtMs) && Number.isSafeInteger(value.expiresAtMs)
      && value.expiresAtMs > value.acquiredAtMs && hex(value.sourceSha256) && hex(value.candidateSha256), 'P363_FOREIGN_LEASE_INVALID');
    return value;
  };
  const writeLease = value => atomicWrite(leasePath, bytes(value), { uid, gid });
  const target = expected => {
    const actual = readTarget(); check(hex(actual) && (!expected || actual === expected), 'P363_TARGET_DRIFT'); return actual;
  };
  const evidence = (value, expectedGraph, revision, orderedGraph, editorOrderedGraph) => {
    check(value && Object.keys(value).sort().join(',') === 'editorOrderedGraphSha256,graphSha256,observedAt,orderedGraphSha256,origin,requestedAt,revisionSha256'
      && value.origin === 'http://127.0.0.1:18801' && hex(value.graphSha256) && hex(value.revisionSha256)
      && value.graphSha256 === expectedGraph && (!revision || value.revisionSha256 === revision)
      && hex(value.orderedGraphSha256) && hex(value.editorOrderedGraphSha256)
      && (!orderedGraph || value.orderedGraphSha256 === orderedGraph)
      && (!editorOrderedGraph || value.editorOrderedGraphSha256 === editorOrderedGraph)
      && typeof value.requestedAt === 'string' && new Date(Date.parse(value.requestedAt)).toISOString() === value.requestedAt
      && Date.parse(value.requestedAt) <= Date.parse(value.observedAt) && now() - Date.parse(value.requestedAt) <= 30000
      && typeof value.observedAt === 'string' && new Date(Date.parse(value.observedAt)).toISOString() === value.observedAt
      && Date.parse(value.observedAt) <= now() && now() - Date.parse(value.observedAt) <= 30000, 'P363_NATIVE_EVIDENCE');
    return value;
  };
  const plan = async expected => {
    const raw = read(file('plan.json')); check(hex(expected) && sha256(raw) === expected, 'P363_PLAN_HASH');
    const p = JSON.parse(raw);
    check(p.kind === KIND && p.formatVersion === 2 && p.codeSha256 === codeHash()
      && /^[a-f0-9]{40}$/.test(p.sourceCommit), 'P363_PLAN_IDENTITY');
    const source = read(file('source.flow.json')), candidate = read(file('candidate.flow.json'));
    check(sha256(source) === p.sourceSha256 && sha256(candidate) === p.candidateSha256, 'P363_BACKUP_DRIFT');
    const built = patchPreview363Flow(JSON.parse(source), { ...patchOptions, sourceCommit: p.sourceCommit });
    check(await preview363GraphHash(built.candidate) === p.candidateGraphSha256
      && await preview363GraphHash(JSON.parse(candidate)) === p.candidateGraphSha256
      && await preview363OrderedGraphHash(JSON.parse(source)) === p.sourceOrderedGraphSha256
      && await preview363OrderedGraphHash(JSON.parse(candidate)) === p.candidateOrderedGraphSha256, 'P363_CANDIDATE_DRIFT');
    validateReviewedFlowContract({ liveBytes: source, candidateBytes: candidate, contract: p.contract });
    check(p.contract.allowedChanges.length === 1 && p.contract.allowedChanges[0].id === built.targetId
      && p.contract.allowedChanges[0].fields.join(',') === 'func', 'P363_CONTRACT_SCOPE');
    target(p.targetSha256); return p;
  };
  const owns = p => {
    const lease = readLease();
    check(lease?.formatVersion === 5 && lease.kind === KIND && lease.stage === stage
      && lease.planSha256 === sha256(read(file('plan.json'))) && lease.codeSha256 === p.codeSha256
      && lease.targetSha256 === p.targetSha256 && lease.sourceSha256 === p.sourceSha256
      && lease.candidateSha256 === p.candidateSha256, 'P363_LEASE_BINDING');
    return lease;
  };
  const pre = async (p, native) => {
    target(p.targetSha256); check(sha256(live()) === p.sourceSha256, 'P363_SOURCE_DRIFT');
    evidence(native, p.sourceGraphSha256, p.preRevisionSha256, p.sourceOrderedGraphSha256, p.editorOrderedGraphSha256);
  };
  const post = async (p, native) => {
    target(p.targetSha256); check(await preview363GraphHash(JSON.parse(live())) === p.candidateGraphSha256
      && await preview363OrderedGraphHash(JSON.parse(live())) === p.candidateOrderedGraphSha256, 'P363_POST_GRAPH');
    evidence(native, p.candidateGraphSha256, undefined, p.candidateOrderedGraphSha256); check(native.revisionSha256 !== p.preRevisionSha256, 'P363_REVISION_UNCHANGED');
  };
  const confirm = async (p, native, ackMode, ackAt) => {
    const lease = owns(p); check(['reserved', 'owner-decision'].includes(lease.phase), 'P363_CONFIRM_PHASE');
    const attempt = json('attempt.json');
    check(attempt.planSha256 === lease.planSha256 && attempt.preRevisionSha256 === p.preRevisionSha256, 'P363_ATTEMPT_BINDING');
    await post(p, native);
    check(now() <= attempt.notAfterMs && Date.parse(native.observedAt) >= ackAt && ackAt >= attempt.requestedAtMs, 'P363_ACK_TIMING');
    const ack = { kind: KIND, planSha256: lease.planSha256, attemptSha256: sha256(read(file('attempt.json'))),
      ackMode, targetSha256: p.targetSha256, diskSha256: sha256(live()), revisionSha256: native.revisionSha256 };
    if (fs.existsSync(file('ack.json'))) check(JSON.stringify(json('ack.json')) === JSON.stringify(ack), 'P363_ACK_DRIFT');
    else write('ack.json', ack);
    writeLease({ ...lease, phase: 'soaking', ackSha256: sha256(read(file('ack.json'))), acquiredAtMs: now(), expiresAtMs: now() + SOAK });
    return { status: 'SOAKING', soakSeconds: SOAK / 1000, candidateSha256: p.candidateSha256, nodeRedRestarted: false, injectInvoked: false };
  };
  return {
    inspect() { return { sourceSha256: sha256(live()), targetSha256: target(), codeSha256: codeHash(), authority: 'native-editor-root-custody' }; },
    async prepare({ expectedSourceSha256, expectedTargetSha256, expectedCodeSha256, sourceCommit, native }) {
      check(hex(expectedSourceSha256) && hex(expectedTargetSha256) && hex(expectedCodeSha256)
        && codeHash() === expectedCodeSha256 && /^[a-f0-9]{40}$/.test(sourceCommit), 'P363_PREPARE_PINS');
      target(expectedTargetSha256); const source = live(); check(sha256(source) === expectedSourceSha256, 'P363_SOURCE_DRIFT');
      check(sha256(source) === (patchOptions.expectedFlowSha256 || PREVIEW363_FLOW_SHA), 'P363_WHOLE_SOURCE_PIN');
      const flow = JSON.parse(source); evidence(native, await preview363GraphHash(flow), undefined, await preview363OrderedGraphHash(flow));
      const built = patchPreview363Flow(flow, { ...patchOptions, sourceCommit }), candidate = bytes(built.candidate);
      const contract = buildExactGraphContract({ liveBytes: source, candidateBytes: candidate, deploymentId: 'preview363-native-diagnostic',
        allowedChanges: [{ id: built.targetId, fields: ['func'] }], allowedAdditionIds: [] });
      validateReviewedFlowContract({ liveBytes: source, candidateBytes: candidate, contract });
      const p = { kind: KIND, formatVersion: 2, sourceCommit, codeSha256: expectedCodeSha256, targetSha256: expectedTargetSha256,
        sourceSha256: sha256(source), candidateSha256: sha256(candidate), sourceGraphSha256: await preview363GraphHash(flow),
        candidateGraphSha256: await preview363GraphHash(built.candidate),
        sourceOrderedGraphSha256: await preview363OrderedGraphHash(flow), candidateOrderedGraphSha256: await preview363OrderedGraphHash(built.candidate),
        editorOrderedGraphSha256: native.editorOrderedGraphSha256, preRevisionSha256: native.revisionSha256,
        beforeFunctionSha256: built.beforeFunctionSha256, afterFunctionSha256: built.afterFunctionSha256,
        preparedAtMs: now(), contract, browserGuardSha256: sha256(buildPreview363BrowserGuard(buildPreview363Artifact(sourceCommit, patchOptions.bundle))) };
      await pre(p, native);
      writeFileExclusiveDurable(file('source.flow.json'), source, protection);
      writeFileExclusiveDurable(file('candidate.flow.json'), candidate, protection); write('plan.json', p);
      return { status: 'PREPARED', planSha256: sha256(read(file('plan.json'))), candidateSha256: p.candidateSha256,
        changedNodeCount: 1, changedFieldCount: 1, liveFlowWritten: false };
    },
    async reserve({ expectedPlanSha256, confirmation, native }) {
      check(confirmation === 'RESERVE_PREVIEW363_NATIVE_NO_RESTART_147', 'P363_RESERVE_CONFIRMATION');
      const p = await plan(expectedPlanSha256); await pre(p, native);
      check(now() >= p.preparedAtMs && now() - p.preparedAtMs <= 1800000, 'P363_PLAN_STALE');
      const previous = readLease();
      if (previous) {
        check(previous.formatVersion === 2 && previous.phase === 'soaking' && Number.isSafeInteger(previous.expiresAtMs)
          && previous.expiresAtMs <= now() && previous.candidateSha256 === p.sourceSha256, 'P363_EXISTING_LEASE');
        writeFileExclusiveDurable(file('predecessor.lease.json'), read(leasePath), protection);
      }
      write('reserve.json', { kind: KIND, planSha256: expectedPlanSha256, sourceSha256: p.sourceSha256,
        candidateSha256: p.candidateSha256, targetSha256: p.targetSha256, reservedAtMs: now() });
      const lease = { formatVersion: 5, kind: KIND, stage, phase: 'reserved', planSha256: expectedPlanSha256,
        codeSha256: p.codeSha256, targetSha256: p.targetSha256, sourceSha256: p.sourceSha256,
        candidateSha256: p.candidateSha256, acquiredAtMs: now(), expiresAtMs: now() + SOAK };
      if (previous) writeLease(lease); else writeFileExclusiveAtomicDurable(leasePath, bytes(lease), protection);
      try { await pre(p, native); } catch { writeLease({ ...lease, phase: 'owner-decision' }); throw new Error('P363_RESERVATION_DRIFT_RETAINED'); }
      return { status: 'RESERVED', liveFlowWritten: false, nodeRedRestarted: false };
    },
    async begin({ expectedPlanSha256, native }) {
      const p = await plan(expectedPlanSha256), lease = owns(p); await pre(p, native);
      check(lease.phase === 'reserved' && lease.expiresAtMs - now() >= 360000, 'P363_RESERVATION_TTL');
      const attempt = { kind: KIND, planSha256: expectedPlanSha256, preRevisionSha256: p.preRevisionSha256,
        requestedAtMs: now(), notAfterMs: now() + 300000 };
      write('attempt.json', attempt);
      const guard = buildPreview363BrowserGuard(buildPreview363Artifact(p.sourceCommit, patchOptions.bundle)); check(sha256(guard) === p.browserGuardSha256, 'P363_BROWSER_CODE_DRIFT');
      writeFileExclusiveDurable(file('browser-guard.js'), Buffer.from(guard), protection);
      return { status: 'ONE_ATTEMPT_RESERVED', seal: { protocol: 'source-preserving-v2', planSha256: expectedPlanSha256, attemptSha256: sha256(read(file('attempt.json'))),
        sourceGraphSha256: p.sourceGraphSha256, candidateGraphSha256: p.candidateGraphSha256,
        sourceOrderedGraphSha256: p.sourceOrderedGraphSha256, candidateOrderedGraphSha256: p.candidateOrderedGraphSha256,
        editorOrderedGraphSha256: p.editorOrderedGraphSha256,
        preRevisionSha256: p.preRevisionSha256, beforeFunctionSha256: p.beforeFunctionSha256,
        afterFunctionSha256: p.afterFunctionSha256, notAfter: new Date(attempt.notAfterMs).toISOString() }, browserGuardSha256: p.browserGuardSha256 };
    },
    async confirm({ expectedPlanSha256, native, audit, httpStatus, ackAt }) {
      const p = await plan(expectedPlanSha256); owns(p);
      check(audit && Object.keys(audit).sort().join(',') === 'attemptSha256,candidateGraphSha256,candidateOrderedGraphSha256,editorOrderedGraphSha256,forwarded,forwardedBodySha256,notAfter,planSha256,preRevisionSha256,rejected,sourceOrderedGraphSha256,status'
        && audit.status === 'FORWARDED_AWAITING_READBACK' && audit.forwarded === 1 && audit.rejected === 0
        && audit.planSha256 === expectedPlanSha256 && audit.attemptSha256 === sha256(read(file('attempt.json')))
        && audit.candidateGraphSha256 === p.candidateGraphSha256 && audit.preRevisionSha256 === p.preRevisionSha256
        && audit.sourceOrderedGraphSha256 === p.sourceOrderedGraphSha256 && audit.candidateOrderedGraphSha256 === p.candidateOrderedGraphSha256
        && audit.editorOrderedGraphSha256 === p.editorOrderedGraphSha256
        && Date.parse(audit.notAfter) === json('attempt.json').notAfterMs && hex(audit.forwardedBodySha256)
        && httpStatus === 200 && Number.isSafeInteger(ackAt) && ackAt <= now(), 'P363_ACK_INPUT');
      return confirm(p, native, 'native-http-200', ackAt);
    },
    async reconcile({ expectedPlanSha256, native }) {
      const p = await plan(expectedPlanSha256); owns(p); let state = 'UNKNOWN';
      try { await pre(p, native); state = 'PRE'; } catch { try { await post(p, native); state = 'POST'; } catch { /* no authority to release */ } }
      return { status: state, attemptConsumed: fs.existsSync(file('attempt.json')), automaticRetry: false, automaticRelease: false };
    },
    async adopt({ expectedPlanSha256, expectedRevisionSha256, confirmation, native }) {
      check(confirmation === 'ADOPT_OBSERVED_PREVIEW363_POST_NO_REPLAY_147' && hex(expectedRevisionSha256), 'P363_ADOPT_CONFIRMATION');
      const p = await plan(expectedPlanSha256); owns(p); await post(p, native);
      check(native.revisionSha256 === expectedRevisionSha256, 'P363_ADOPT_REVISION_DRIFT');
      // Explicit adoption attests observed POST, never fabricates an HTTP ACK.
      const attempt = json('attempt.json'); check(attempt.planSha256 === expectedPlanSha256, 'P363_ATTEMPT_BINDING');
      const lease = owns(p);
      check(['reserved', 'owner-decision'].includes(lease.phase), 'P363_ADOPT_PHASE');
      const ack = { kind: KIND, planSha256: expectedPlanSha256, attemptSha256: sha256(read(file('attempt.json'))),
        ackMode: 'observed-post-adoption', targetSha256: p.targetSha256, diskSha256: sha256(live()), revisionSha256: native.revisionSha256 };
      if (fs.existsSync(file('ack.json'))) {
        const old = json('ack.json');
        check(old.kind === ack.kind && old.planSha256 === ack.planSha256 && old.attemptSha256 === ack.attemptSha256
          && old.targetSha256 === ack.targetSha256 && old.diskSha256 === ack.diskSha256 && old.revisionSha256 === ack.revisionSha256
          && ['native-http-200', 'observed-post-adoption'].includes(old.ackMode), 'P363_ACK_DRIFT');
      } else write('ack.json', ack);
      writeLease({ ...lease, phase: 'soaking', ackSha256: sha256(read(file('ack.json'))), acquiredAtMs: now(), expiresAtMs: now() + SOAK });
      return { status: 'SOAKING', ackMode: 'observed-post-adoption', soakSeconds: SOAK / 1000, automaticRetry: false };
    },
    async rollbackReserve({ expectedPlanSha256, confirmation, native }) {
      check(confirmation === 'ROLLBACK_PREVIEW363_NATIVE_SOURCE_NO_RESTART_147', 'P363_ROLLBACK_CONFIRMATION');
      const p = await plan(expectedPlanSha256), lease = owns(p);
      check(['reserved', 'owner-decision', 'soaking'].includes(lease.phase)
        && fs.existsSync(file('attempt.json')), 'P363_ROLLBACK_PHASE');
      await post(p, native);
      write('rollback-reserve.json', { kind: KIND, planSha256: expectedPlanSha256,
        preRevisionSha256: native.revisionSha256, editorOrderedGraphSha256: native.editorOrderedGraphSha256, requestedAtMs: now(), notAfterMs: now() + 300000 });
      writeLease({ ...lease, phase: 'rollback-reserved', acquiredAtMs: now(), expiresAtMs: now() + SOAK });
      return { status: 'ROLLBACK_RESERVED', liveFlowWritten: false, nodeRedRestarted: false };
    },
    async rollbackBegin({ expectedPlanSha256, native }) {
      const p = await plan(expectedPlanSha256), lease = owns(p), reserve = json('rollback-reserve.json');
      check(lease.phase === 'rollback-reserved' && reserve.planSha256 === expectedPlanSha256
        && now() <= reserve.notAfterMs, 'P363_ROLLBACK_PHASE');
      await post(p, native); check(native.revisionSha256 === reserve.preRevisionSha256
        && native.editorOrderedGraphSha256 === reserve.editorOrderedGraphSha256, 'P363_ROLLBACK_REVISION_DRIFT');
      const attempt = { kind: KIND, planSha256: expectedPlanSha256, preRevisionSha256: native.revisionSha256,
        requestedAtMs: now(), notAfterMs: now() + 300000 };
      write('rollback-attempt.json', attempt);
      const guard = buildPreview363BrowserGuard(buildPreview363Artifact(p.sourceCommit, patchOptions.bundle));
      check(sha256(guard) === p.browserGuardSha256, 'P363_BROWSER_CODE_DRIFT');
      return { status: 'ONE_ROLLBACK_ATTEMPT_RESERVED', seal: { protocol: 'source-preserving-v2', planSha256: expectedPlanSha256,
        attemptSha256: sha256(read(file('rollback-attempt.json'))), sourceGraphSha256: p.candidateGraphSha256,
        candidateGraphSha256: p.sourceGraphSha256, preRevisionSha256: native.revisionSha256,
        sourceOrderedGraphSha256: p.candidateOrderedGraphSha256, candidateOrderedGraphSha256: p.sourceOrderedGraphSha256,
        editorOrderedGraphSha256: reserve.editorOrderedGraphSha256,
        beforeFunctionSha256: p.afterFunctionSha256, afterFunctionSha256: p.beforeFunctionSha256,
        reverse: true, notAfter: new Date(attempt.notAfterMs).toISOString() }, browserGuardSha256: p.browserGuardSha256 };
    },
    async rollbackConfirm({ expectedPlanSha256, native, audit, httpStatus, ackAt }) {
      const p = await plan(expectedPlanSha256), lease = owns(p), attempt = json('rollback-attempt.json');
      check(lease.phase === 'rollback-reserved' && attempt.planSha256 === expectedPlanSha256
        && now() <= attempt.notAfterMs, 'P363_ROLLBACK_PHASE');
      check(audit && Object.keys(audit).sort().join(',') === 'attemptSha256,candidateGraphSha256,candidateOrderedGraphSha256,editorOrderedGraphSha256,forwarded,forwardedBodySha256,notAfter,planSha256,preRevisionSha256,rejected,sourceOrderedGraphSha256,status'
        && audit.status === 'FORWARDED_AWAITING_READBACK' && audit.forwarded === 1 && audit.rejected === 0
        && audit.planSha256 === expectedPlanSha256 && audit.attemptSha256 === sha256(read(file('rollback-attempt.json')))
        && audit.candidateGraphSha256 === p.sourceGraphSha256 && audit.preRevisionSha256 === attempt.preRevisionSha256
        && audit.sourceOrderedGraphSha256 === p.candidateOrderedGraphSha256 && audit.candidateOrderedGraphSha256 === p.sourceOrderedGraphSha256
        && audit.editorOrderedGraphSha256 === json('rollback-reserve.json').editorOrderedGraphSha256
        && Date.parse(audit.notAfter) === attempt.notAfterMs && hex(audit.forwardedBodySha256)
        && httpStatus === 200 && Number.isSafeInteger(ackAt) && ackAt <= now()
        && ackAt >= attempt.requestedAtMs && Date.parse(native.observedAt) >= ackAt, 'P363_ROLLBACK_ACK_INPUT');
      target(p.targetSha256); check(await preview363GraphHash(JSON.parse(live())) === p.sourceGraphSha256
        && await preview363OrderedGraphHash(JSON.parse(live())) === p.sourceOrderedGraphSha256, 'P363_ROLLBACK_GRAPH');
      evidence(native, p.sourceGraphSha256, undefined, p.sourceOrderedGraphSha256); check(native.revisionSha256 !== attempt.preRevisionSha256, 'P363_REVISION_UNCHANGED');
      const ack = { kind: KIND, planSha256: expectedPlanSha256, attemptSha256: sha256(read(file('rollback-attempt.json'))),
        ackMode: 'native-http-200', diskSha256: sha256(live()), revisionSha256: native.revisionSha256 };
      if (fs.existsSync(file('rollback-ack.json'))) check(JSON.stringify(json('rollback-ack.json')) === JSON.stringify(ack), 'P363_ROLLBACK_ACK_DRIFT');
      else write('rollback-ack.json', ack);
      writeLease({ ...lease, phase: 'rollback-soaking', rollbackAckSha256: sha256(read(file('rollback-ack.json'))),
        acquiredAtMs: now(), expiresAtMs: now() + SOAK });
      return { status: 'ROLLBACK_SOAKING', soakSeconds: SOAK / 1000, nodeRedRestarted: false };
    },
    async rollbackAdopt({ expectedPlanSha256, expectedRevisionSha256, confirmation, native }) {
      check(confirmation === 'ADOPT_OBSERVED_PREVIEW363_SOURCE_NO_REPLAY_147' && hex(expectedRevisionSha256), 'P363_ROLLBACK_ADOPT_CONFIRMATION');
      const p = await plan(expectedPlanSha256), lease = owns(p), attempt = json('rollback-attempt.json');
      check(['rollback-reserved', 'owner-decision'].includes(lease.phase)
        && attempt.planSha256 === expectedPlanSha256, 'P363_ROLLBACK_PHASE');
      target(p.targetSha256); check(await preview363GraphHash(JSON.parse(live())) === p.sourceGraphSha256
        && await preview363OrderedGraphHash(JSON.parse(live())) === p.sourceOrderedGraphSha256, 'P363_ROLLBACK_GRAPH');
      evidence(native, p.sourceGraphSha256, expectedRevisionSha256, p.sourceOrderedGraphSha256);
      check(native.revisionSha256 !== attempt.preRevisionSha256
        && Date.parse(native.observedAt) >= attempt.requestedAtMs, 'P363_ROLLBACK_REVISION_DRIFT');
      const ack = { kind: KIND, planSha256: expectedPlanSha256, attemptSha256: sha256(read(file('rollback-attempt.json'))),
        ackMode: 'observed-source-adoption', diskSha256: sha256(live()), revisionSha256: native.revisionSha256 };
      if (fs.existsSync(file('rollback-ack.json'))) {
        const old = json('rollback-ack.json');
        check(old.kind === ack.kind && old.planSha256 === ack.planSha256 && old.attemptSha256 === ack.attemptSha256
          && old.diskSha256 === ack.diskSha256 && old.revisionSha256 === ack.revisionSha256
          && ['native-http-200', 'observed-source-adoption'].includes(old.ackMode), 'P363_ROLLBACK_ACK_DRIFT');
      } else write('rollback-ack.json', ack);
      writeLease({ ...lease, phase: 'rollback-soaking', rollbackAckSha256: sha256(read(file('rollback-ack.json'))),
        acquiredAtMs: now(), expiresAtMs: now() + SOAK });
      return { status: 'ROLLBACK_SOAKING', ackMode: 'observed-source-adoption', automaticRetry: false, soakSeconds: SOAK / 1000 };
    },
    async rollbackFinish({ expectedPlanSha256, native }) {
      const p = await plan(expectedPlanSha256), lease = readLease(), ackRaw = read(file('rollback-ack.json')), ack = JSON.parse(ackRaw);
      check(ack.kind === KIND && ack.planSha256 === expectedPlanSha256
        && ['native-http-200', 'observed-source-adoption'].includes(ack.ackMode)
        && ack.attemptSha256 === sha256(read(file('rollback-attempt.json'))), 'P363_ROLLBACK_ACK_BINDING');
      const exists = fs.existsSync(file('rollback-finish.json'));
      if (lease) {
        const own = owns(p); check(own.phase === 'rollback-soaking' && own.rollbackAckSha256 === sha256(ackRaw)
          && now() >= own.expiresAtMs && own.expiresAtMs - own.acquiredAtMs === SOAK
          && Date.parse(native.observedAt) >= own.expiresAtMs, 'P363_SOAK_INCOMPLETE');
      } else check(exists, 'P363_LEASE_ABSENT');
      target(p.targetSha256); check(await preview363GraphHash(JSON.parse(live())) === p.sourceGraphSha256
        && await preview363OrderedGraphHash(JSON.parse(live())) === p.sourceOrderedGraphSha256
        && sha256(live()) === ack.diskSha256, 'P363_ROLLBACK_FINISH_DRIFT');
      evidence(native, p.sourceGraphSha256, ack.revisionSha256, p.sourceOrderedGraphSha256);
      const receipt = { kind: KIND, planSha256: expectedPlanSha256, ackSha256: sha256(ackRaw),
        diskSha256: ack.diskSha256, targetSha256: p.targetSha256, revisionSha256: ack.revisionSha256 };
      if (exists) check(JSON.stringify(json('rollback-finish.json')) === JSON.stringify(receipt), 'P363_ROLLBACK_RECEIPT_DRIFT');
      else write('rollback-finish.json', receipt);
      if (lease) { owns(p); fs.unlinkSync(leasePath); syncDirectory(root); }
      return { status: 'ROLLED_BACK', leaseReleased: true, nodeRedRestarted: false, injectInvoked: false };
    },
    async finish({ expectedPlanSha256, native }) {
      const p = await plan(expectedPlanSha256), lease = readLease(), ackRaw = read(file('ack.json')), ack = JSON.parse(ackRaw);
      check(ack.kind === KIND && ack.planSha256 === expectedPlanSha256 && ack.targetSha256 === p.targetSha256
        && ['native-http-200', 'observed-post-adoption'].includes(ack.ackMode)
        && ack.attemptSha256 === sha256(read(file('attempt.json'))), 'P363_ACK_BINDING');
      const receiptExists = fs.existsSync(file('finish.json'));
      if (lease) { const owned = owns(p); check(owned.phase === 'soaking' && owned.ackSha256 === sha256(ackRaw)
        && now() >= owned.expiresAtMs && owned.expiresAtMs - owned.acquiredAtMs === SOAK
        && Date.parse(native.observedAt) >= owned.expiresAtMs, 'P363_SOAK_INCOMPLETE'); }
      else check(receiptExists, 'P363_LEASE_ABSENT');
      await post(p, native); check(native.revisionSha256 === ack.revisionSha256 && sha256(live()) === ack.diskSha256, 'P363_FINISH_DRIFT');
      const receipt = { kind: KIND, planSha256: expectedPlanSha256, ackSha256: sha256(ackRaw), targetSha256: p.targetSha256,
        candidateSha256: p.candidateSha256, diskSha256: ack.diskSha256, revisionSha256: ack.revisionSha256 };
      if (receiptExists) check(JSON.stringify(json('finish.json')) === JSON.stringify(receipt), 'P363_FINISH_RECEIPT_DRIFT'); else write('finish.json', receipt);
      if (lease) { owns(p); fs.unlinkSync(leasePath); syncDirectory(root); }
      return { status: 'FINISHED', leaseReleased: true, nodeRedRestarted: false, injectInvoked: false };
    },
    async abort({ expectedPlanSha256, native }) {
      const p = await plan(expectedPlanSha256), lease = readLease();
      if (lease) owns(p); else check(fs.existsSync(file('abort.json')), 'P363_LEASE_ABSENT');
      check(!fs.existsSync(file('attempt.json')), 'P363_ATTEMPT_MAY_HAVE_EFFECT'); await pre(p, native);
      const receipt = { kind: KIND, planSha256: expectedPlanSha256, sourceSha256: p.sourceSha256, targetSha256: p.targetSha256 };
      if (!fs.existsSync(file('abort.json'))) write('abort.json', receipt);
      else check(JSON.stringify(json('abort.json')) === JSON.stringify(receipt), 'P363_ABORT_RECEIPT_DRIFT');
      await pre(p, native);
      if (lease) { owns(p); fs.unlinkSync(leasePath); syncDirectory(root); }
      return { status: 'ABORTED_BEFORE_ATTEMPT', leaseReleased: true };
    },
  };
}

async function main() {
  check(process.getuid() === 0, 'P363_ROOT_REQUIRED');
  const [action, stage] = process.argv.slice(2);
  check(process.argv.length === 4 && ['inspect', 'prepare', 'reserve', 'begin', 'confirm', 'reconcile', 'adopt', 'finish', 'abort',
    'rollbackReserve', 'rollbackBegin', 'rollbackConfirm', 'rollbackAdopt', 'rollbackFinish'].includes(action), 'P363_ARGUMENTS');
  const operation = createPreview363NativeOperation({ stage });
  const input = action === 'inspect' ? undefined : JSON.parse(fs.readFileSync(0, 'utf8'));
  console.log(JSON.stringify(await operation[action](input)));
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    check(process.getuid() === 0, 'P363_ROOT_REQUIRED');
    if (process.env.PADLHUB_PREVIEW363_LOCK_HELD !== '1') {
      const lock = path.join(ROOT, '.padlhub-reviewed-flow-deploy.lock');
      const fd = fs.openSync(lock, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
      try { const st = fs.fstatSync(fd); check(st.isFile() && st.uid === 0 && st.nlink === 1 && (st.mode & 0o777) === 0o600, 'P363_LOCK_CUSTODY'); } finally { fs.closeSync(fd); }
      // Input/output are inherited: only the child reads safe operator evidence.
      const result = spawnSync('flock', ['-E', '75', '-n', lock, process.execPath, fileURLToPath(import.meta.url), ...process.argv.slice(2)],
        { env: { ...process.env, PADLHUB_PREVIEW363_LOCK_HELD: '1' }, stdio: 'inherit', timeout: 60000 });
      check(!result.error && Number.isInteger(result.status), 'P363_LOCK_REFUSED'); process.exitCode = result.status;
    } else await main();
  } catch { console.error('Preview363 native operation refused; preserve stage and lease for guarded reconciliation'); process.exitCode = 1; }
}
