#!/usr/bin/env node
// Root custody for one original, authenticated native-editor request. This file
// never calls /flows, writes flows.json, reads tokens or restarts a process.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {sha256} from '../nodered_max_outbox_resume.mjs';
import {buildMaxOutboxOnlyInverse,inverseContract} from '../nodered_max_outbox_inverse.mjs';
import {max_outboxOperationCodeHash} from './max_outbox_native_operation.mjs';
import { writeFileExclusiveDurable,
  writeFileExclusiveAtomicDurable, recoverAtomicExclusivePublication, atomicWrite, syncDirectory } from './runtime_contract.mjs';
import { max_outbox_inverseGraphHash, max_outbox_inverseOrderedGraphHash } from './max_outbox_inverse_body_preserver.mjs';
import { buildMaxOutboxInverseBrowserGuard } from './max_outbox_inverse_browser_guard.mjs';

const ROOT = '/root/.node-red', LEASE = '.padlhub-reviewed-flow-deploy.lease.json';
const KIND = 'max-outbox-inverse-native-nodes', SOAK = 900000;
const hex = s => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
const check = (ok, code) => { if (!ok) throw new Error(code); };
const bytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
export function max_outbox_inverseOperationCodeHash() {
  return sha256(Buffer.concat(['max_outbox_inverse_native_operation.mjs', 'max_outbox_inverse_body_preserver.mjs',
    'max_outbox_inverse_browser_guard.mjs', 'runtime_contract.mjs', '../nodered_max_outbox_inverse.mjs', '../nodered_max_outbox_resume.mjs', 'max_outbox_native_operation.mjs', 'max_outbox_body_preserver.mjs', 'max_outbox_browser_guard.mjs']
    .map(name => fs.readFileSync(new URL(name, import.meta.url)))));
}
export function readMaxOutboxInverseTarget() {
  const list = JSON.parse(execFileSync('pm2', ['jlist'], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }));
  const found = list.filter(p => p.name === 'node-red'); check(found.length === 1, 'MAXOI_PROCESS');
  const p = found[0], env = p.pm2_env;
  check(env.status === 'online' && Number.isSafeInteger(p.pid) && p.pid > 0
    && Number.isSafeInteger(env.restart_time) && fs.statSync(`/proc/${p.pid}`).uid === 0, 'MAXOI_PROCESS_OWNER');
  const listeners = execFileSync('ss', ['-ltnpH'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] })
    .split('\n').filter(l => /:1880\s/.test(l));
  check(listeners.length === 1 && listeners[0].includes(`pid=${p.pid},`), 'MAXOI_LISTENER_OWNER');
  const settings = `${ROOT}/settings.js`, st = fs.lstatSync(settings);
  check(st.isFile() && !st.isSymbolicLink() && st.uid === 0 && st.nlink === 1 && !(st.mode & 0o022), 'MAXOI_SETTINGS');
  const entry = fs.realpathSync(env.pm_exec_path), version = JSON.parse(fs.readFileSync(path.join(path.dirname(entry), 'package.json'))).version;
  check(version === '4.0.9', 'MAXOI_RUNTIME_VERSION');
  return sha256(bytes({ machine: sha256(fs.readFileSync('/etc/machine-id')), pid: p.pid, restarts: env.restart_time,
    executable: fs.readlinkSync(`/proc/${p.pid}/exe`), cwd: fs.readlinkSync(`/proc/${p.pid}/cwd`),
    command: sha256(fs.readFileSync(`/proc/${p.pid}/cmdline`)), entry, settings: sha256(fs.readFileSync(settings)), version }));
}

export function createMaxOutboxInverseNativeOperation({ stage, root = ROOT, uid = 0, gid = 0,
  getUid = () => process.getuid(), now = Date.now, readTarget = readMaxOutboxInverseTarget,
  codeHash = max_outbox_inverseOperationCodeHash } = {}) {
  const protection = { uid, gid, mode: 0o600 };
  check(getUid() === uid && path.dirname(stage) === root
    && /^\.padlhub-max_outbox_inverse-stage-\d{8}T\d{6}Z-\d+$/.test(path.basename(stage)), 'MAXOI_STAGE_PATH');
  const dir = fs.lstatSync(stage);
  check(dir.isDirectory() && !dir.isSymbolicLink() && fs.realpathSync(stage) === stage
    && dir.uid === uid && dir.gid === gid && (dir.mode & 0o777) === 0o700, 'MAXOI_STAGE_CUSTODY');
  const file = name => path.join(stage, name), leasePath = path.join(root, LEASE);
  const read = (name, modes = [0o600], links = [1]) => {
    const fd = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const st = fs.fstatSync(fd), link = fs.lstatSync(name);
      check(st.isFile() && links.includes(st.nlink) && st.uid === uid && st.gid === gid && modes.includes(st.mode & 0o777)
        && st.ino === link.ino && st.dev === link.dev, 'MAXOI_FILE_CUSTODY');
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
      check(value.formatVersion === 4 && value.kind === KIND && value.stage === stage, 'MAXOI_FOREIGN_PARTIAL_LEASE');
      recoverAtomicExclusivePublication(leasePath, protection);
    }
    const value = JSON.parse(read(leasePath));
    if (value.formatVersion === 2) check(typeof value.deploymentId === 'string'
      && /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/.test(value.deploymentId)
      && typeof value.token === 'string' && value.token.trim().length > 0
      && ['applying', 'soaking', 'rollback-restart-required'].includes(value.phase)
      && Number.isSafeInteger(value.acquiredAtMs) && Number.isSafeInteger(value.expiresAtMs)
      && value.expiresAtMs > value.acquiredAtMs && hex(value.sourceSha256) && hex(value.candidateSha256), 'MAXOI_FOREIGN_LEASE_INVALID');
    return value;
  };
  const writeLease = value => atomicWrite(leasePath, bytes(value), { uid, gid });
  const target = expected => {
    const actual = readTarget(); check(hex(actual) && (!expected || actual === expected), 'MAXOI_TARGET_DRIFT'); return actual;
  };
  const evidence = (value, expectedGraph, expectedOrderedGraph, revision, editorOrderedGraph) => {
    check(value && Object.keys(value).sort().join(',') === 'editorOrderedGraphSha256,graphSha256,observedAt,orderedGraphSha256,origin,requestedAt,revisionSha256'
      && value.origin === 'http://127.0.0.1:18801' && hex(value.graphSha256) && hex(value.revisionSha256)
      && hex(value.orderedGraphSha256) && value.orderedGraphSha256 === expectedOrderedGraph
      && hex(value.editorOrderedGraphSha256) && (!editorOrderedGraph || value.editorOrderedGraphSha256 === editorOrderedGraph)
      && value.graphSha256 === expectedGraph && (!revision || value.revisionSha256 === revision)
      && typeof value.requestedAt === 'string' && new Date(Date.parse(value.requestedAt)).toISOString() === value.requestedAt
      && Date.parse(value.requestedAt) <= Date.parse(value.observedAt)
      && typeof value.observedAt === 'string' && new Date(Date.parse(value.observedAt)).toISOString() === value.observedAt
      && Date.parse(value.observedAt) <= now() && now() - Date.parse(value.observedAt) <= 30000, 'MAXOI_NATIVE_EVIDENCE');
    return value;
  };
  const plan = async expected => {
    const raw = read(file('plan.json')); check(hex(expected) && sha256(raw) === expected, 'MAXOI_PLAN_HASH');
    const p = JSON.parse(raw);
    check(p.kind === KIND && p.formatVersion === 2 && hex(p.editorOrderedGraphSha256) && p.codeSha256 === codeHash()
      && /^[a-f0-9]{40}$/.test(p.sourceCommit), 'MAXOI_PLAN_IDENTITY');
    const source = read(file('source.flow.json')), candidate = read(file('candidate.flow.json'));
    check(sha256(source) === p.sourceSha256 && sha256(candidate) === p.candidateSha256, 'MAXOI_BACKUP_DRIFT');
    const original=read(file('original.flow.json')); const built = buildMaxOutboxOnlyInverse(source,original,p.trustedPins);
    check(await max_outbox_inverseOrderedGraphHash(JSON.parse(source)) === p.sourceOrderedGraphSha256
      && await max_outbox_inverseOrderedGraphHash(built.flow) === p.candidateOrderedGraphSha256
      && await max_outbox_inverseOrderedGraphHash(JSON.parse(candidate)) === p.candidateOrderedGraphSha256
      && await max_outbox_inverseGraphHash(built.flow) === p.candidateGraphSha256
      && await max_outbox_inverseGraphHash(JSON.parse(candidate)) === p.candidateGraphSha256, 'MAXOI_CANDIDATE_DRIFT');
    check(JSON.stringify(p.contract)===JSON.stringify(inverseContract(source,original,p.trustedPins)), 'MAXOI_CONTRACT_SCOPE');
    target(p.targetSha256); return p;
  };
  const owns = p => {
    const lease = readLease();
    check(lease?.formatVersion === 4 && lease.kind === KIND && lease.stage === stage
      && lease.planSha256 === sha256(read(file('plan.json'))) && lease.codeSha256 === p.codeSha256
      && lease.targetSha256 === p.targetSha256 && lease.sourceSha256 === p.sourceSha256
      && lease.candidateSha256 === p.candidateSha256, 'MAXOI_LEASE_BINDING');
    return lease;
  };
  const pre = async (p, native) => {
    target(p.targetSha256); check(sha256(live()) === p.sourceSha256, 'MAXOI_SOURCE_DRIFT');
    evidence(native, p.sourceGraphSha256, p.sourceOrderedGraphSha256, p.preRevisionSha256, p.editorOrderedGraphSha256);
  };
  const post = async (p, native) => {
    target(p.targetSha256); const flow = JSON.parse(live());
    check(await max_outbox_inverseGraphHash(flow) === p.candidateGraphSha256
      && await max_outbox_inverseOrderedGraphHash(flow) === p.candidateOrderedGraphSha256, 'MAXOI_POST_GRAPH');
    evidence(native, p.candidateGraphSha256, p.candidateOrderedGraphSha256); check(native.revisionSha256 !== p.preRevisionSha256, 'MAXOI_REVISION_UNCHANGED');
  };
  const confirm = async (p, native, ackMode, ackAt) => {
    const lease = owns(p); check(['reserved', 'owner-decision'].includes(lease.phase), 'MAXOI_CONFIRM_PHASE');
    const attempt = json('attempt.json');
    check(attempt.planSha256 === lease.planSha256 && attempt.preRevisionSha256 === p.preRevisionSha256
      && attempt.sourceOrderedGraphSha256 === p.sourceOrderedGraphSha256 && attempt.candidateOrderedGraphSha256 === p.candidateOrderedGraphSha256
      && attempt.editorOrderedGraphSha256 === p.editorOrderedGraphSha256, 'MAXOI_ATTEMPT_BINDING');
    await post(p, native);
    check(now() <= attempt.notAfterMs && Date.parse(native.requestedAt) >= ackAt && ackAt >= attempt.requestedAtMs, 'MAXOI_ACK_TIMING');
    const ack = { kind: KIND, planSha256: lease.planSha256, attemptSha256: sha256(read(file('attempt.json'))),
      sourceOrderedGraphSha256: p.sourceOrderedGraphSha256, candidateOrderedGraphSha256: p.candidateOrderedGraphSha256,
      editorOrderedGraphSha256: p.editorOrderedGraphSha256,
      ackMode, targetSha256: p.targetSha256, diskSha256: sha256(live()), revisionSha256: native.revisionSha256 };
    if (fs.existsSync(file('ack.json'))) check(JSON.stringify(json('ack.json')) === JSON.stringify(ack), 'MAXOI_ACK_DRIFT');
    else write('ack.json', ack);
    writeLease({ ...lease, phase: 'soaking', ackSha256: sha256(read(file('ack.json'))), acquiredAtMs: now(), expiresAtMs: now() + SOAK });
    return { status: 'SOAKING', soakSeconds: SOAK / 1000, candidateSha256: p.candidateSha256, nodeRedRestarted: false, injectInvoked: false };
  };
  return {
    inspect() { return { sourceSha256: sha256(live()), targetSha256: target(), codeSha256: codeHash(), authority: 'native-editor-root-custody' }; },
    async prepare({ expectedSourceSha256, expectedTargetSha256, expectedCodeSha256, sourceCommit, forwardStage, forwardPlanSha256, native }) {
      check(hex(expectedSourceSha256) && hex(expectedTargetSha256) && hex(expectedCodeSha256)
        && codeHash() === expectedCodeSha256 && /^[a-f0-9]{40}$/.test(sourceCommit), 'MAXOI_PREPARE_PINS');
      target(expectedTargetSha256); const source = live(); check(sha256(source) === expectedSourceSha256, 'MAXOI_SOURCE_DRIFT');
      const flow = JSON.parse(source); evidence(native, await max_outbox_inverseGraphHash(flow), await max_outbox_inverseOrderedGraphHash(flow));
      check(path.dirname(forwardStage)===root && /^\.padlhub-max_outbox-stage-\d{8}T\d{6}Z-\d+$/.test(path.basename(forwardStage)), 'MAXOI_FORWARD_PATH');
      const fst=fs.lstatSync(forwardStage);check(fst.isDirectory()&&!fst.isSymbolicLink()&&fs.realpathSync(forwardStage)===forwardStage&&fst.uid===uid&&fst.gid===gid&&(fst.mode&0o777)===0o700,'MAXOI_FORWARD_CUSTODY');
      const fpraw=read(path.join(forwardStage,'plan.json')),fp=JSON.parse(fpraw),original=read(path.join(forwardStage,'source.flow.json'));
      check(hex(forwardPlanSha256)&&sha256(fpraw)===forwardPlanSha256&&fp.kind==='max-outbox-native-nodes'&&fp.codeSha256===max_outboxOperationCodeHash()
        &&fp.sourceSha256===sha256(original)&&fp.targetSha256===expectedTargetSha256,'MAXOI_FORWARD_PLAN');
      const trustedPins=fp.trustedPins,built=buildMaxOutboxOnlyInverse(source,original,trustedPins),candidate=bytes(built.flow);
      const contract=inverseContract(source,original,trustedPins);
      writeFileExclusiveDurable(file('original.flow.json'),original,protection);
      const p = { kind: KIND, formatVersion: 2, sourceCommit, forwardStage, forwardPlanSha256, forwardCodeSha256: max_outboxOperationCodeHash(), trustedPins: structuredClone(trustedPins), codeSha256: expectedCodeSha256, targetSha256: expectedTargetSha256,
        sourceSha256: sha256(source), candidateSha256: sha256(candidate), sourceGraphSha256: await max_outbox_inverseGraphHash(flow),
        sourceOrderedGraphSha256: await max_outbox_inverseOrderedGraphHash(flow), candidateOrderedGraphSha256: await max_outbox_inverseOrderedGraphHash(built.flow),
        editorOrderedGraphSha256: native.editorOrderedGraphSha256,
        candidateGraphSha256: await max_outbox_inverseGraphHash(built.flow), preRevisionSha256: native.revisionSha256,
        preparedAtMs: now(), contract, browserGuardSha256: sha256(buildMaxOutboxInverseBrowserGuard()) };
      await pre(p, native);
      writeFileExclusiveDurable(file('source.flow.json'), source, protection);
      writeFileExclusiveDurable(file('candidate.flow.json'), candidate, protection); write('plan.json', p);
      return { status: 'PREPARED', planSha256: sha256(read(file('plan.json'))), candidateSha256: p.candidateSha256,
        changedNodeCount: 4, removedNodeCount: 2, liveFlowWritten: false };
    },
    async reserve({ expectedPlanSha256, confirmation, native }) {
      check(confirmation === 'RESERVE_MAX_OUTBOX_INVERSE_NATIVE_NO_RESTART_147', 'MAXOI_RESERVE_CONFIRMATION');
      const p = await plan(expectedPlanSha256); await pre(p, native);
      check(now() >= p.preparedAtMs && now() - p.preparedAtMs <= 1800000, 'MAXOI_PLAN_STALE');
      const previous = readLease();
      if (previous) {
        check(previous.formatVersion===4 && previous.kind==='max-outbox-native-nodes' && previous.stage===p.forwardStage
          && previous.planSha256===p.forwardPlanSha256 && previous.codeSha256===p.forwardCodeSha256
          && previous.targetSha256===p.targetSha256 && ['reserved','soaking','owner-decision'].includes(previous.phase), 'MAXOI_EXISTING_LEASE');
        const fpraw=read(path.join(p.forwardStage,'plan.json')),fp=JSON.parse(fpraw);
        check(sha256(fpraw)===p.forwardPlanSha256 && previous.sourceSha256===fp.sourceSha256 && previous.candidateSha256===fp.candidateSha256
          && Number.isSafeInteger(previous.acquiredAtMs) && Number.isSafeInteger(previous.expiresAtMs)
          && previous.acquiredAtMs>=fp.preparedAtMs && previous.expiresAtMs-previous.acquiredAtMs===SOAK, 'MAXOI_PREDECESSOR_BINDING');
        const attempt=JSON.parse(read(path.join(p.forwardStage,'attempt.json')));
        check(attempt.planSha256===p.forwardPlanSha256 && attempt.preRevisionSha256===fp.preRevisionSha256
          && attempt.sourceOrderedGraphSha256===fp.sourceOrderedGraphSha256 && attempt.candidateOrderedGraphSha256===fp.candidateOrderedGraphSha256,
          'MAXOI_PREDECESSOR_ATTEMPT');
        if(previous.phase==='soaking'){
          const ackraw=read(path.join(p.forwardStage,'ack.json')),ack=JSON.parse(ackraw);
          check(sha256(ackraw)===previous.ackSha256 && ack.kind==='max-outbox-native-nodes' && ack.planSha256===p.forwardPlanSha256
            && ack.targetSha256===p.targetSha256 && ack.sourceOrderedGraphSha256===fp.sourceOrderedGraphSha256
            && ack.candidateOrderedGraphSha256===fp.candidateOrderedGraphSha256 && ack.diskSha256===p.sourceSha256
            && hex(ack.revisionSha256), 'MAXOI_PREDECESSOR_ACK');
        }
        writeFileExclusiveDurable(file('predecessor.lease.json'), read(leasePath), protection);
      }
      write('reserve.json', { kind: KIND, planSha256: expectedPlanSha256, sourceSha256: p.sourceSha256,
        candidateSha256: p.candidateSha256, targetSha256: p.targetSha256, reservedAtMs: now() });
      const lease = { formatVersion: 4, kind: KIND, stage, phase: 'reserved', planSha256: expectedPlanSha256,
        codeSha256: p.codeSha256, targetSha256: p.targetSha256, sourceSha256: p.sourceSha256,
        candidateSha256: p.candidateSha256, acquiredAtMs: now(), expiresAtMs: now() + SOAK };
      if (previous) writeLease(lease); else writeFileExclusiveAtomicDurable(leasePath, bytes(lease), protection);
      try { await pre(p, native); } catch { writeLease({ ...lease, phase: 'owner-decision' }); throw new Error('MAXOI_RESERVATION_DRIFT_RETAINED'); }
      return { status: 'RESERVED', liveFlowWritten: false, nodeRedRestarted: false };
    },
    async begin({ expectedPlanSha256, native }) {
      const p = await plan(expectedPlanSha256), lease = owns(p); await pre(p, native);
      check(lease.phase === 'reserved' && lease.expiresAtMs - now() >= 360000, 'MAXOI_RESERVATION_TTL');
      const attempt = { kind: KIND, planSha256: expectedPlanSha256, preRevisionSha256: p.preRevisionSha256,
        sourceOrderedGraphSha256: p.sourceOrderedGraphSha256, candidateOrderedGraphSha256: p.candidateOrderedGraphSha256,
        editorOrderedGraphSha256: p.editorOrderedGraphSha256,
        requestedAtMs: now(), notAfterMs: now() + 300000 };
      write('attempt.json', attempt);
      const guard = buildMaxOutboxInverseBrowserGuard(); check(sha256(guard) === p.browserGuardSha256, 'MAXOI_BROWSER_CODE_DRIFT');
      writeFileExclusiveDurable(file('browser-guard.js'), Buffer.from(guard), protection);
      return { status: 'ONE_ATTEMPT_RESERVED', seal: { protocol: 'source-preserving-v2', planSha256: expectedPlanSha256, attemptSha256: sha256(read(file('attempt.json'))),
        sourceGraphSha256: p.sourceGraphSha256, candidateGraphSha256: p.candidateGraphSha256,
        sourceOrderedGraphSha256: p.sourceOrderedGraphSha256, candidateOrderedGraphSha256: p.candidateOrderedGraphSha256,
        editorOrderedGraphSha256: p.editorOrderedGraphSha256,
        preRevisionSha256: p.preRevisionSha256, notAfter: new Date(attempt.notAfterMs).toISOString() }, browserGuardSha256: p.browserGuardSha256 };
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
        && httpStatus === 200 && Number.isSafeInteger(ackAt) && ackAt <= now(), 'MAXOI_ACK_INPUT');
      return confirm(p, native, 'native-http-200', ackAt);
    },
    async reconcile({ expectedPlanSha256, native }) {
      const p = await plan(expectedPlanSha256); owns(p); let state = 'UNKNOWN';
      try { await pre(p, native); state = 'PRE'; } catch { try { await post(p, native); state = 'POST'; } catch { /* no authority to release */ } }
      return { status: state, attemptConsumed: fs.existsSync(file('attempt.json')), automaticRetry: false, automaticRelease: false };
    },
    async adopt({ expectedPlanSha256, expectedRevisionSha256, confirmation, native }) {
      check(confirmation === 'ADOPT_OBSERVED_MAX_OUTBOX_INVERSE_POST_NO_REPLAY_147' && hex(expectedRevisionSha256), 'MAXOI_ADOPT_CONFIRMATION');
      const p = await plan(expectedPlanSha256); owns(p); await post(p, native);
      check(native.revisionSha256 === expectedRevisionSha256, 'MAXOI_ADOPT_REVISION_DRIFT');
      // Explicit adoption attests observed POST, never fabricates an HTTP ACK.
      const attempt = json('attempt.json'); check(attempt.planSha256 === expectedPlanSha256
        && attempt.preRevisionSha256 === p.preRevisionSha256 && attempt.sourceOrderedGraphSha256 === p.sourceOrderedGraphSha256
        && attempt.candidateOrderedGraphSha256 === p.candidateOrderedGraphSha256
        && attempt.editorOrderedGraphSha256 === p.editorOrderedGraphSha256, 'MAXOI_ATTEMPT_BINDING');
      const lease = owns(p);
      check(['reserved', 'owner-decision'].includes(lease.phase), 'MAXOI_ADOPT_PHASE');
      const ack = { kind: KIND, planSha256: expectedPlanSha256, attemptSha256: sha256(read(file('attempt.json'))),
        sourceOrderedGraphSha256: p.sourceOrderedGraphSha256, candidateOrderedGraphSha256: p.candidateOrderedGraphSha256,
        editorOrderedGraphSha256: p.editorOrderedGraphSha256,
        ackMode: 'observed-post-adoption', targetSha256: p.targetSha256, diskSha256: sha256(live()), revisionSha256: native.revisionSha256 };
      if (fs.existsSync(file('ack.json'))) {
        const old = json('ack.json');
        check(old.kind === ack.kind && old.planSha256 === ack.planSha256 && old.attemptSha256 === ack.attemptSha256
          && old.targetSha256 === ack.targetSha256 && old.diskSha256 === ack.diskSha256 && old.revisionSha256 === ack.revisionSha256
          && old.sourceOrderedGraphSha256 === ack.sourceOrderedGraphSha256 && old.candidateOrderedGraphSha256 === ack.candidateOrderedGraphSha256
          && old.editorOrderedGraphSha256 === ack.editorOrderedGraphSha256
          && ['native-http-200', 'observed-post-adoption'].includes(old.ackMode), 'MAXOI_ACK_DRIFT');
      } else write('ack.json', ack);
      writeLease({ ...lease, phase: 'soaking', ackSha256: sha256(read(file('ack.json'))), acquiredAtMs: now(), expiresAtMs: now() + SOAK });
      return { status: 'SOAKING', ackMode: 'observed-post-adoption', soakSeconds: SOAK / 1000, automaticRetry: false };
    },
    async finish({ expectedPlanSha256, native }) {
      const p = await plan(expectedPlanSha256), lease = readLease(), ackRaw = read(file('ack.json')), ack = JSON.parse(ackRaw);
      check(ack.kind === KIND && ack.planSha256 === expectedPlanSha256 && ack.targetSha256 === p.targetSha256
        && ack.sourceOrderedGraphSha256 === p.sourceOrderedGraphSha256 && ack.candidateOrderedGraphSha256 === p.candidateOrderedGraphSha256
        && ack.editorOrderedGraphSha256 === p.editorOrderedGraphSha256
        && ['native-http-200', 'observed-post-adoption'].includes(ack.ackMode)
        && ack.attemptSha256 === sha256(read(file('attempt.json'))), 'MAXOI_ACK_BINDING');
      const receiptExists = fs.existsSync(file('finish.json'));
      if (lease) { const owned = owns(p); check(owned.phase === 'soaking' && owned.ackSha256 === sha256(ackRaw)
        && now() >= owned.expiresAtMs && owned.expiresAtMs - owned.acquiredAtMs === SOAK
        && Date.parse(native.requestedAt) >= owned.expiresAtMs, 'MAXOI_SOAK_INCOMPLETE'); }
      else check(receiptExists, 'MAXOI_LEASE_ABSENT');
      await post(p, native); check(native.revisionSha256 === ack.revisionSha256 && sha256(live()) === ack.diskSha256, 'MAXOI_FINISH_DRIFT');
      const receipt = { kind: KIND, planSha256: expectedPlanSha256, ackSha256: sha256(ackRaw), targetSha256: p.targetSha256,
        candidateSha256: p.candidateSha256, diskSha256: ack.diskSha256, revisionSha256: ack.revisionSha256 };
      if (receiptExists) check(JSON.stringify(json('finish.json')) === JSON.stringify(receipt), 'MAXOI_FINISH_RECEIPT_DRIFT'); else write('finish.json', receipt);
      if (lease) { owns(p); fs.unlinkSync(leasePath); syncDirectory(root); }
      return { status: 'FINISHED', leaseReleased: true, nodeRedRestarted: false, injectInvoked: false };
    },
    async abort({ expectedPlanSha256, native }) {
      const p = await plan(expectedPlanSha256), lease = readLease();
      if (lease) owns(p); else check(fs.existsSync(file('abort.json')), 'MAXOI_LEASE_ABSENT');
      check(!fs.existsSync(file('attempt.json')), 'MAXOI_ATTEMPT_MAY_HAVE_EFFECT'); await pre(p, native);
      const receipt = { kind: KIND, planSha256: expectedPlanSha256, sourceSha256: p.sourceSha256, targetSha256: p.targetSha256 };
      if (!fs.existsSync(file('abort.json'))) write('abort.json', receipt);
      else check(JSON.stringify(json('abort.json')) === JSON.stringify(receipt), 'MAXOI_ABORT_RECEIPT_DRIFT');
      await pre(p, native);
      if(fs.existsSync(file('predecessor.lease.json'))){
        // The forward soak may still be incomplete. Do not drop its custody
        // when an inverse is abandoned before its own native request.
        if(lease)owns(p);
        return {status:'ABORTED_BEFORE_ATTEMPT_CUSTODY_RETAINED',leaseReleased:false,guardedHandbackRequired:true};
      }
      if (lease) { owns(p); fs.unlinkSync(leasePath); syncDirectory(root); }
      return { status: 'ABORTED_BEFORE_ATTEMPT', leaseReleased: true };
    },
  };
}

async function main() {
  check(process.getuid() === 0, 'MAXOI_ROOT_REQUIRED');
  const [action, stage] = process.argv.slice(2);
  check(process.argv.length === 4 && ['inspect', 'prepare', 'reserve', 'begin', 'confirm', 'reconcile', 'adopt', 'finish', 'abort'].includes(action), 'MAXOI_ARGUMENTS');
  const operation = createMaxOutboxInverseNativeOperation({ stage });
  const input = action === 'inspect' ? undefined : JSON.parse(fs.readFileSync(0, 'utf8'));
  console.log(JSON.stringify(await operation[action](input)));
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    check(process.getuid() === 0, 'MAXOI_ROOT_REQUIRED');
    if (process.env.PADLHUB_MAX_OUTBOX_INVERSE_LOCK_HELD !== '1') {
      const lock = path.join(ROOT, '.padlhub-reviewed-flow-deploy.lock');
      const fd = fs.openSync(lock, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
      try { const st = fs.fstatSync(fd); check(st.isFile() && st.uid === 0 && st.nlink === 1 && (st.mode & 0o777) === 0o600, 'MAXOI_LOCK_CUSTODY'); } finally { fs.closeSync(fd); }
      // Input/output are inherited: only the child reads safe operator evidence.
      const result = spawnSync('flock', ['-E', '75', '-n', lock, process.execPath, fileURLToPath(import.meta.url), ...process.argv.slice(2)],
        { env: { ...process.env, PADLHUB_MAX_OUTBOX_INVERSE_LOCK_HELD: '1' }, stdio: 'inherit', timeout: 60000 });
      check(!result.error && Number.isInteger(result.status), 'MAXOI_LOCK_REFUSED'); process.exitCode = result.status;
    } else await main();
  } catch { console.error('MaxOutboxInverse native operation refused; preserve stage and lease for guarded reconciliation'); process.exitCode = 1; }
}
