#!/usr/bin/env node
// Root custody for one original, authenticated native-editor request. This file
// never calls /flows, writes flows.json, reads tokens or restarts a process.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildCollectorCandidate as patchCollectorFlow } from '../diagnostics/split-leave-collector.mjs';
import { createHash } from 'node:crypto';
const sha256 = value => createHash('sha256').update(value).digest('hex');
import { buildExactGraphContract, validateReviewedFlowContract, writeFileExclusiveDurable,
  writeFileExclusiveAtomicDurable, recoverAtomicExclusivePublication, atomicWrite, syncDirectory } from './runtime_contract.mjs';
import { collectorGraphHash, collectorOrderedGraphHash } from './collector_body_preserver.mjs';
import { buildCollectorBrowserGuard } from './collector_browser_guard.mjs';

const ROOT = '/root/.node-red', LEASE = '.padlhub-reviewed-flow-deploy.lease.json';
const KIND = 'collector-native-nodes', SOAK = 900000;
const hex = s => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
const check = (ok, code) => { if (!ok) throw new Error(code); };
const bytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
export function collectorOperationCodeHash() {
  return sha256(Buffer.concat(['collector_native_operation.mjs', 'collector_body_preserver.mjs',
    'collector_browser_guard.mjs', 'runtime_contract.mjs', '../diagnostics/split-leave-collector.mjs', '../../src/utils/errorDiagnosticsCore.mjs']
    .map(name => fs.readFileSync(new URL(name, import.meta.url)))));
}
export function readCollectorTarget() {
  const list = JSON.parse(execFileSync('pm2', ['jlist'], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }));
  const found = list.filter(p => p.name === 'node-red'); check(found.length === 1, 'LCI_PROCESS');
  const p = found[0], env = p.pm2_env;
  check(env.status === 'online' && Number.isSafeInteger(p.pid) && p.pid > 0
    && Number.isSafeInteger(env.restart_time) && fs.statSync(`/proc/${p.pid}`).uid === 0, 'LCI_PROCESS_OWNER');
  const listeners = execFileSync('ss', ['-ltnpH'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] })
    .split('\n').filter(l => /:1880\s/.test(l));
  check(listeners.length === 1 && listeners[0].includes(`pid=${p.pid},`), 'LCI_LISTENER_OWNER');
  const settings = `${ROOT}/settings.js`, st = fs.lstatSync(settings);
  check(st.isFile() && !st.isSymbolicLink() && st.uid === 0 && st.nlink === 1 && !(st.mode & 0o022), 'LCI_SETTINGS');
  const entry = fs.realpathSync(env.pm_exec_path), version = JSON.parse(fs.readFileSync(path.join(path.dirname(entry), 'package.json'))).version;
  check(version === '4.0.9', 'LCI_RUNTIME_VERSION');
  return sha256(bytes({ machine: sha256(fs.readFileSync('/etc/machine-id')), pid: p.pid, restarts: env.restart_time,
    executable: fs.readlinkSync(`/proc/${p.pid}/exe`), cwd: fs.readlinkSync(`/proc/${p.pid}/cwd`),
    command: sha256(fs.readFileSync(`/proc/${p.pid}/cmdline`)), entry, settings: sha256(fs.readFileSync(settings)), version }));
}

export function createCollectorNativeOperation({ stage, root = ROOT, uid = 0, gid = 0,
  getUid = () => process.getuid(), now = Date.now, readTarget = readCollectorTarget,
  codeHash = collectorOperationCodeHash } = {}) {
  const protection = { uid, gid, mode: 0o600 };
  check(getUid() === uid && path.dirname(stage) === root
    && /^\.padlhub-collector-stage-\d{8}T\d{6}Z-\d+$/.test(path.basename(stage)), 'LCI_STAGE_PATH');
  const dir = fs.lstatSync(stage);
  check(dir.isDirectory() && !dir.isSymbolicLink() && fs.realpathSync(stage) === stage
    && dir.uid === uid && dir.gid === gid && (dir.mode & 0o777) === 0o700, 'LCI_STAGE_CUSTODY');
  const file = name => path.join(stage, name), leasePath = path.join(root, LEASE);
  const read = (name, modes = [0o600], links = [1]) => {
    const fd = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const st = fs.fstatSync(fd), link = fs.lstatSync(name);
      check(st.isFile() && links.includes(st.nlink) && st.uid === uid && st.gid === gid && modes.includes(st.mode & 0o777)
        && st.ino === link.ino && st.dev === link.dev, 'LCI_FILE_CUSTODY');
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
      check(value.formatVersion === 4 && value.kind === KIND && value.stage === stage, 'LCI_FOREIGN_PARTIAL_LEASE');
      recoverAtomicExclusivePublication(leasePath, protection);
    }
    const value = JSON.parse(read(leasePath));
    if (value.formatVersion === 2) check(typeof value.deploymentId === 'string'
      && /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/.test(value.deploymentId)
      && typeof value.token === 'string' && value.token.trim().length > 0
      && ['applying', 'soaking', 'rollback-restart-required'].includes(value.phase)
      && Number.isSafeInteger(value.acquiredAtMs) && Number.isSafeInteger(value.expiresAtMs)
      && value.expiresAtMs > value.acquiredAtMs && hex(value.sourceSha256) && hex(value.candidateSha256), 'LCI_FOREIGN_LEASE_INVALID');
    return value;
  };
  const writeLease = value => atomicWrite(leasePath, bytes(value), { uid, gid });
  const target = expected => {
    const actual = readTarget(); check(hex(actual) && (!expected || actual === expected), 'LCI_TARGET_DRIFT'); return actual;
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
      && Date.parse(value.observedAt) <= now() && now() - Date.parse(value.observedAt) <= 30000, 'LCI_NATIVE_EVIDENCE');
    return value;
  };
  const plan = async expected => {
    const raw = read(file('plan.json')); check(hex(expected) && sha256(raw) === expected, 'LCI_PLAN_HASH');
    const p = JSON.parse(raw);
    check(p.kind === KIND && p.formatVersion === 2 && hex(p.editorOrderedGraphSha256) && p.codeSha256 === codeHash()
      && /^[a-f0-9]{40}$/.test(p.sourceCommit), 'LCI_PLAN_IDENTITY');
    const source = read(file('source.flow.json')), candidate = read(file('candidate.flow.json'));
    check(sha256(source) === p.sourceSha256 && sha256(candidate) === p.candidateSha256, 'LCI_BACKUP_DRIFT');
    const built = patchCollectorFlow(JSON.parse(source), { release: p.sourceCommit, routeHash: p.beforeRouteSha256 });
    check(await collectorOrderedGraphHash(JSON.parse(source)) === p.sourceOrderedGraphSha256
      && await collectorOrderedGraphHash(built.candidate) === p.candidateOrderedGraphSha256
      && await collectorOrderedGraphHash(JSON.parse(candidate)) === p.candidateOrderedGraphSha256
      && await collectorGraphHash(built.candidate) === p.candidateGraphSha256
      && await collectorGraphHash(JSON.parse(candidate)) === p.candidateGraphSha256, 'LCI_CANDIDATE_DRIFT');
    validateReviewedFlowContract({ liveBytes: source, candidateBytes: candidate, contract: p.contract });
    check(p.contract.allowedChanges.length === 1 && p.contract.allowedChanges[0].id === built.targetId
      && p.contract.allowedChanges[0].fields.join(',') === 'wires' && p.contract.allowedAdditions.length === 1 && p.contract.allowedAdditions[0].id === built.gate.id, 'LCI_CONTRACT_SCOPE');
    target(p.targetSha256); return p;
  };
  const owns = p => {
    const lease = readLease();
    check(lease?.formatVersion === 4 && lease.kind === KIND && lease.stage === stage
      && lease.planSha256 === sha256(read(file('plan.json'))) && lease.codeSha256 === p.codeSha256
      && lease.targetSha256 === p.targetSha256 && lease.sourceSha256 === p.sourceSha256
      && lease.candidateSha256 === p.candidateSha256, 'LCI_LEASE_BINDING');
    return lease;
  };
  const pre = async (p, native) => {
    target(p.targetSha256); check(sha256(live()) === p.sourceSha256, 'LCI_SOURCE_DRIFT');
    evidence(native, p.sourceGraphSha256, p.sourceOrderedGraphSha256, p.preRevisionSha256, p.editorOrderedGraphSha256);
  };
  const post = async (p, native) => {
    target(p.targetSha256); const flow = JSON.parse(live());
    check(await collectorGraphHash(flow) === p.candidateGraphSha256
      && await collectorOrderedGraphHash(flow) === p.candidateOrderedGraphSha256, 'LCI_POST_GRAPH');
    evidence(native, p.candidateGraphSha256, p.candidateOrderedGraphSha256); check(native.revisionSha256 !== p.preRevisionSha256, 'LCI_REVISION_UNCHANGED');
  };
  const confirm = async (p, native, ackMode, ackAt) => {
    const lease = owns(p); check(['reserved', 'owner-decision'].includes(lease.phase), 'LCI_CONFIRM_PHASE');
    const attempt = json('attempt.json');
    check(attempt.planSha256 === lease.planSha256 && attempt.preRevisionSha256 === p.preRevisionSha256
      && attempt.sourceOrderedGraphSha256 === p.sourceOrderedGraphSha256 && attempt.candidateOrderedGraphSha256 === p.candidateOrderedGraphSha256
      && attempt.editorOrderedGraphSha256 === p.editorOrderedGraphSha256, 'LCI_ATTEMPT_BINDING');
    await post(p, native);
    check(now() <= attempt.notAfterMs && Date.parse(native.requestedAt) >= ackAt && ackAt >= attempt.requestedAtMs, 'LCI_ACK_TIMING');
    const ack = { kind: KIND, planSha256: lease.planSha256, attemptSha256: sha256(read(file('attempt.json'))),
      sourceOrderedGraphSha256: p.sourceOrderedGraphSha256, candidateOrderedGraphSha256: p.candidateOrderedGraphSha256,
      editorOrderedGraphSha256: p.editorOrderedGraphSha256,
      ackMode, targetSha256: p.targetSha256, diskSha256: sha256(live()), revisionSha256: native.revisionSha256 };
    if (fs.existsSync(file('ack.json'))) check(JSON.stringify(json('ack.json')) === JSON.stringify(ack), 'LCI_ACK_DRIFT');
    else write('ack.json', ack);
    writeLease({ ...lease, phase: 'soaking', ackSha256: sha256(read(file('ack.json'))), acquiredAtMs: now(), expiresAtMs: now() + SOAK });
    return { status: 'SOAKING', soakSeconds: SOAK / 1000, candidateSha256: p.candidateSha256, nodeRedRestarted: false, injectInvoked: false };
  };
  return {
    inspect() { return { sourceSha256: sha256(live()), targetSha256: target(), codeSha256: codeHash(), authority: 'native-editor-root-custody' }; },
    async prepare({ expectedSourceSha256, expectedTargetSha256, expectedCodeSha256, expectedRouteSha256, sourceCommit, native }) {
      check(hex(expectedSourceSha256) && hex(expectedTargetSha256) && hex(expectedCodeSha256)
        && codeHash() === expectedCodeSha256 && /^[a-f0-9]{40}$/.test(sourceCommit), 'LCI_PREPARE_PINS');
      target(expectedTargetSha256); const source = live(); check(sha256(source) === expectedSourceSha256, 'LCI_SOURCE_DRIFT');
      const flow = JSON.parse(source); evidence(native, await collectorGraphHash(flow), await collectorOrderedGraphHash(flow));
      const built = patchCollectorFlow(flow, { release: sourceCommit, routeHash: expectedRouteSha256 }), candidate = bytes(built.candidate);
      const contract = buildExactGraphContract({ liveBytes: source, candidateBytes: candidate, deploymentId: 'collector-native-diagnostic',
        allowedChanges: [{ id: built.targetId, fields: ['wires'] }], allowedAdditionIds: [built.gate.id] });
      validateReviewedFlowContract({ liveBytes: source, candidateBytes: candidate, contract });
      const p = { kind: KIND, formatVersion: 2, sourceCommit, codeSha256: expectedCodeSha256, targetSha256: expectedTargetSha256,
        sourceSha256: sha256(source), candidateSha256: sha256(candidate), sourceGraphSha256: await collectorGraphHash(flow),
        sourceOrderedGraphSha256: await collectorOrderedGraphHash(flow), candidateOrderedGraphSha256: await collectorOrderedGraphHash(built.candidate),
        gate: built.gate, beforeWires: built.beforeWires,
        editorOrderedGraphSha256: native.editorOrderedGraphSha256,
        candidateGraphSha256: await collectorGraphHash(built.candidate), preRevisionSha256: native.revisionSha256,
        beforeRouteSha256: built.beforeRouteSha256, gateSha256: built.gateSha256,
        preparedAtMs: now(), contract, browserGuardSha256: sha256(buildCollectorBrowserGuard()) };
      await pre(p, native);
      writeFileExclusiveDurable(file('source.flow.json'), source, protection);
      writeFileExclusiveDurable(file('candidate.flow.json'), candidate, protection); write('plan.json', p);
      return { status: 'PREPARED', planSha256: sha256(read(file('plan.json'))), candidateSha256: p.candidateSha256,
        changedNodeCount: 1, changedFieldCount: 1, addedNodeCount: 1, liveFlowWritten: false };
    },
    async reserve({ expectedPlanSha256, confirmation, native, expectedPredecessorLeaseSha256, expectedPredecessorDeploymentId }) {
      check(confirmation === 'RESERVE_COLLECTOR_NATIVE_NO_RESTART_147', 'LCI_RESERVE_CONFIRMATION');
      const p = await plan(expectedPlanSha256); await pre(p, native);
      check(now() >= p.preparedAtMs && now() - p.preparedAtMs <= 1800000, 'LCI_PLAN_STALE');
      const previous = readLease();
      if (previous) {
        check(hex(expectedPredecessorLeaseSha256) && sha256(read(leasePath)) === expectedPredecessorLeaseSha256
          && previous.deploymentId === expectedPredecessorDeploymentId, 'LCI_PREDECESSOR_PIN');
        check(previous.formatVersion === 2 && previous.phase === 'soaking' && Number.isSafeInteger(previous.expiresAtMs)
          && previous.expiresAtMs <= now() && previous.candidateSha256 === p.sourceSha256, 'LCI_EXISTING_LEASE');
        writeFileExclusiveDurable(file('predecessor.lease.json'), read(leasePath), protection);
      } else check(expectedPredecessorLeaseSha256 === undefined && expectedPredecessorDeploymentId === undefined, 'LCI_PREDECESSOR_MISSING');
      write('reserve.json', { kind: KIND, planSha256: expectedPlanSha256, sourceSha256: p.sourceSha256,
        candidateSha256: p.candidateSha256, targetSha256: p.targetSha256, reservedAtMs: now() });
      const lease = { formatVersion: 4, kind: KIND, stage, phase: 'reserved', planSha256: expectedPlanSha256,
        codeSha256: p.codeSha256, targetSha256: p.targetSha256, sourceSha256: p.sourceSha256,
        candidateSha256: p.candidateSha256, acquiredAtMs: now(), expiresAtMs: now() + SOAK };
      if (previous) writeLease(lease); else writeFileExclusiveAtomicDurable(leasePath, bytes(lease), protection);
      try { await pre(p, native); } catch { writeLease({ ...lease, phase: 'owner-decision' }); throw new Error('LCI_RESERVATION_DRIFT_RETAINED'); }
      return { status: 'RESERVED', liveFlowWritten: false, nodeRedRestarted: false };
    },
    async begin({ expectedPlanSha256, native }) {
      const p = await plan(expectedPlanSha256), lease = owns(p); await pre(p, native);
      check(lease.phase === 'reserved' && lease.expiresAtMs - now() >= 360000, 'LCI_RESERVATION_TTL');
      const attempt = { kind: KIND, planSha256: expectedPlanSha256, preRevisionSha256: p.preRevisionSha256,
        sourceOrderedGraphSha256: p.sourceOrderedGraphSha256, candidateOrderedGraphSha256: p.candidateOrderedGraphSha256,
        editorOrderedGraphSha256: p.editorOrderedGraphSha256,
        requestedAtMs: now(), notAfterMs: now() + 300000 };
      write('attempt.json', attempt);
      const guard = buildCollectorBrowserGuard(); check(sha256(guard) === p.browserGuardSha256, 'LCI_BROWSER_CODE_DRIFT');
      writeFileExclusiveDurable(file('browser-guard.js'), Buffer.from(guard), protection);
      return { status: 'ONE_ATTEMPT_RESERVED', seal: { protocol: 'source-preserving-v2', planSha256: expectedPlanSha256, attemptSha256: sha256(read(file('attempt.json'))),
        sourceGraphSha256: p.sourceGraphSha256, candidateGraphSha256: p.candidateGraphSha256,
        sourceOrderedGraphSha256: p.sourceOrderedGraphSha256, candidateOrderedGraphSha256: p.candidateOrderedGraphSha256,
        editorOrderedGraphSha256: p.editorOrderedGraphSha256,
        preRevisionSha256: p.preRevisionSha256, beforeRouteSha256: p.beforeRouteSha256,
        gateSha256: p.gateSha256, gate: p.gate, beforeWires: p.beforeWires, routeId: p.contract.allowedChanges[0].id, notAfter: new Date(attempt.notAfterMs).toISOString() }, browserGuardSha256: p.browserGuardSha256 };
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
        && httpStatus === 200 && Number.isSafeInteger(ackAt) && ackAt <= now(), 'LCI_ACK_INPUT');
      return confirm(p, native, 'native-http-200', ackAt);
    },
    async reconcile({ expectedPlanSha256, native }) {
      const p = await plan(expectedPlanSha256); owns(p); let state = 'UNKNOWN';
      try { await pre(p, native); state = 'PRE'; } catch { try { await post(p, native); state = 'POST'; } catch {
        if (fs.existsSync(file('attempt.inverse.json'))) {
          try {
            target(p.targetSha256); const graph = JSON.parse(live());
            check(await collectorGraphHash(graph) === p.sourceGraphSha256
              && await collectorOrderedGraphHash(graph) === p.sourceOrderedGraphSha256, 'LCI_INVERSE_GRAPH');
            evidence(native, p.sourceGraphSha256, p.sourceOrderedGraphSha256); state = 'RESTORED_SOURCE';
          } catch { /* no authority to release */ }
        }
      } }
      return { status: state, attemptConsumed: fs.existsSync(file('attempt.json')), automaticRetry: false, automaticRelease: false };
    },
    async adopt({ expectedPlanSha256, expectedRevisionSha256, confirmation, native }) {
      check(confirmation === 'ADOPT_OBSERVED_COLLECTOR_POST_NO_REPLAY_147' && hex(expectedRevisionSha256), 'LCI_ADOPT_CONFIRMATION');
      const p = await plan(expectedPlanSha256); owns(p); await post(p, native);
      check(native.revisionSha256 === expectedRevisionSha256, 'LCI_ADOPT_REVISION_DRIFT');
      // Explicit adoption attests observed POST, never fabricates an HTTP ACK.
      const attempt = json('attempt.json'); check(attempt.planSha256 === expectedPlanSha256
        && attempt.preRevisionSha256 === p.preRevisionSha256 && attempt.sourceOrderedGraphSha256 === p.sourceOrderedGraphSha256
        && attempt.candidateOrderedGraphSha256 === p.candidateOrderedGraphSha256
        && attempt.editorOrderedGraphSha256 === p.editorOrderedGraphSha256, 'LCI_ATTEMPT_BINDING');
      const lease = owns(p);
      check(['reserved', 'owner-decision'].includes(lease.phase), 'LCI_ADOPT_PHASE');
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
          && ['native-http-200', 'observed-post-adoption'].includes(old.ackMode), 'LCI_ACK_DRIFT');
      } else write('ack.json', ack);
      writeLease({ ...lease, phase: 'soaking', ackSha256: sha256(read(file('ack.json'))), acquiredAtMs: now(), expiresAtMs: now() + SOAK });
      return { status: 'SOAKING', ackMode: 'observed-post-adoption', soakSeconds: SOAK / 1000, automaticRetry: false };
    },
    async beginInverse({ expectedPlanSha256, native, confirmation }) {
      check(confirmation === 'RESTORE_COLLECTOR_SOURCE_NO_BUSINESS_ROLLBACK_147', 'LCI_INVERSE_CONFIRMATION');
      const p = await plan(expectedPlanSha256), lease = owns(p);
      check(['soaking', 'owner-decision', 'reserved', 'inverse-reserved'].includes(lease.phase), 'LCI_INVERSE_PHASE');
      await post(p, native);
      let attempt = { kind: KIND, planSha256: expectedPlanSha256, preRevisionSha256: native.revisionSha256,
        sourceOrderedGraphSha256: p.candidateOrderedGraphSha256, candidateOrderedGraphSha256: p.sourceOrderedGraphSha256,
        editorOrderedGraphSha256: native.editorOrderedGraphSha256, requestedAtMs: now(), notAfterMs: now() + 300000 };
      if (fs.existsSync(file('attempt.inverse.json'))) {
        const saved = json('attempt.inverse.json');
        check(saved.kind === KIND && saved.planSha256 === attempt.planSha256
          && saved.preRevisionSha256 === attempt.preRevisionSha256
          && saved.sourceOrderedGraphSha256 === attempt.sourceOrderedGraphSha256
          && saved.candidateOrderedGraphSha256 === attempt.candidateOrderedGraphSha256
          && saved.editorOrderedGraphSha256 === attempt.editorOrderedGraphSha256
          && saved.requestedAtMs <= now() && now() <= saved.notAfterMs, 'LCI_INVERSE_ATTEMPT_DRIFT');
        attempt = saved;
      } else write('attempt.inverse.json', attempt);
      writeLease({ ...lease, phase: 'inverse-reserved', acquiredAtMs: attempt.requestedAtMs, expiresAtMs: attempt.requestedAtMs + SOAK });
      const candidate = JSON.parse(read(file('candidate.flow.json')));
      const route = candidate.find(node => node.id === p.contract.allowedChanges[0].id);
      return { status: 'ONE_INVERSE_ATTEMPT_RESERVED', seal: { protocol: 'source-preserving-v2', inverse: true,
        planSha256: expectedPlanSha256, attemptSha256: sha256(read(file('attempt.inverse.json'))),
        sourceGraphSha256: p.candidateGraphSha256, candidateGraphSha256: p.sourceGraphSha256,
        sourceOrderedGraphSha256: p.candidateOrderedGraphSha256, candidateOrderedGraphSha256: p.sourceOrderedGraphSha256,
        editorOrderedGraphSha256: native.editorOrderedGraphSha256, preRevisionSha256: native.revisionSha256,
        beforeRouteSha256: sha256(JSON.stringify(route)), gateSha256: p.gateSha256, gate: p.gate,
        beforeWires: p.beforeWires, routeId: route.id, notAfter: new Date(attempt.notAfterMs).toISOString() } };
    },
    async confirmInverse({ expectedPlanSha256, native, audit, httpStatus, ackAt }) {
      const p = await plan(expectedPlanSha256), lease = owns(p), attemptRaw = read(file('attempt.inverse.json'));
      const attempt = JSON.parse(attemptRaw);
      check(['inverse-reserved', 'inverse-soaking'].includes(lease.phase) && httpStatus === 200 && Number.isSafeInteger(ackAt)
        && attempt.requestedAtMs <= ackAt && ackAt <= now() && (fs.existsSync(file('ack.inverse.json')) || now() <= attempt.notAfterMs)
        && Date.parse(native.requestedAt) >= ackAt, 'LCI_INVERSE_ACK_TIMING');
      check(audit && Object.keys(audit).sort().join(',') === 'attemptSha256,candidateGraphSha256,candidateOrderedGraphSha256,editorOrderedGraphSha256,forwarded,forwardedBodySha256,notAfter,planSha256,preRevisionSha256,rejected,sourceOrderedGraphSha256,status'
        && audit.status === 'FORWARDED_AWAITING_READBACK' && audit.forwarded === 1 && audit.rejected === 0
        && audit.planSha256 === expectedPlanSha256 && audit.attemptSha256 === sha256(attemptRaw)
        && audit.candidateGraphSha256 === p.sourceGraphSha256 && audit.preRevisionSha256 === attempt.preRevisionSha256
        && audit.sourceOrderedGraphSha256 === p.candidateOrderedGraphSha256
        && audit.candidateOrderedGraphSha256 === p.sourceOrderedGraphSha256
        && audit.editorOrderedGraphSha256 === attempt.editorOrderedGraphSha256
        && Date.parse(audit.notAfter) === attempt.notAfterMs && hex(audit.forwardedBodySha256), 'LCI_INVERSE_ACK');
      target(p.targetSha256);
      const flow = JSON.parse(live());
      check(await collectorGraphHash(flow) === p.sourceGraphSha256
        && await collectorOrderedGraphHash(flow) === p.sourceOrderedGraphSha256, 'LCI_INVERSE_DISK');
      evidence(native, p.sourceGraphSha256, p.sourceOrderedGraphSha256);
      check(native.revisionSha256 !== attempt.preRevisionSha256, 'LCI_INVERSE_REVISION');
      const ack = { planSha256: expectedPlanSha256, attemptSha256: sha256(attemptRaw),
        diskSha256: sha256(live()), revisionSha256: native.revisionSha256, targetSha256: p.targetSha256 };
      if (fs.existsSync(file('ack.inverse.json'))) check(JSON.stringify(json('ack.inverse.json')) === JSON.stringify(ack), 'LCI_INVERSE_ACK_DRIFT');
      else write('ack.inverse.json', ack);
      if (lease.phase === 'inverse-soaking') {
        check(lease.ackSha256 === sha256(read(file('ack.inverse.json'))), 'LCI_INVERSE_LEASE_ACK');
        return { status: 'INVERSE_SOAKING', soakSeconds: SOAK / 1000, nodeRedRestarted: false };
      }
      writeLease({ ...lease, phase: 'inverse-soaking', ackSha256: sha256(read(file('ack.inverse.json'))),
        acquiredAtMs: now(), expiresAtMs: now() + SOAK });
      return { status: 'INVERSE_SOAKING', soakSeconds: SOAK / 1000, nodeRedRestarted: false };
    },
    async adoptInverse({ expectedPlanSha256, expectedRevisionSha256, native, confirmation }) {
      check(confirmation === 'ADOPT_OBSERVED_COLLECTOR_SOURCE_NO_REPLAY_147' && hex(expectedRevisionSha256), 'LCI_INVERSE_ADOPT_CONFIRMATION');
      const p = await plan(expectedPlanSha256), lease = owns(p), attemptRaw = read(file('attempt.inverse.json'));
      check(['inverse-reserved', 'inverse-soaking', 'soaking', 'owner-decision', 'reserved'].includes(lease.phase), 'LCI_INVERSE_ADOPT_PHASE');
      const attempt = JSON.parse(attemptRaw);
      check(attempt.planSha256 === expectedPlanSha256 && attempt.sourceOrderedGraphSha256 === p.candidateOrderedGraphSha256
        && attempt.candidateOrderedGraphSha256 === p.sourceOrderedGraphSha256, 'LCI_INVERSE_ATTEMPT_BINDING');
      target(p.targetSha256);
      const graph = JSON.parse(live());
      check(await collectorGraphHash(graph) === p.sourceGraphSha256
        && await collectorOrderedGraphHash(graph) === p.sourceOrderedGraphSha256, 'LCI_INVERSE_ADOPT_DISK');
      evidence(native, p.sourceGraphSha256, p.sourceOrderedGraphSha256, expectedRevisionSha256);
      check(native.revisionSha256 !== attempt.preRevisionSha256, 'LCI_INVERSE_ADOPT_REVISION');
      const ack = { planSha256: expectedPlanSha256, attemptSha256: sha256(attemptRaw),
        diskSha256: sha256(live()), revisionSha256: native.revisionSha256, targetSha256: p.targetSha256 };
      if (fs.existsSync(file('ack.inverse.json'))) check(JSON.stringify(json('ack.inverse.json')) === JSON.stringify(ack), 'LCI_INVERSE_ACK_DRIFT');
      else write('ack.inverse.json', ack);
      const adoption = { ackMode: 'observed-source-adoption', planSha256: expectedPlanSha256,
        revisionSha256: native.revisionSha256, diskSha256: ack.diskSha256 };
      if (fs.existsSync(file('adopt.inverse.json'))) check(JSON.stringify(json('adopt.inverse.json')) === JSON.stringify(adoption), 'LCI_INVERSE_ADOPTION_DRIFT');
      else write('adopt.inverse.json', adoption);
      if (lease.phase !== 'inverse-soaking') writeLease({ ...lease, phase: 'inverse-soaking',
        ackSha256: sha256(read(file('ack.inverse.json'))), acquiredAtMs: now(), expiresAtMs: now() + SOAK });
      else check(lease.ackSha256 === sha256(read(file('ack.inverse.json'))), 'LCI_INVERSE_LEASE_ACK');
      return { status: 'INVERSE_SOAKING', ackMode: 'observed-source-adoption', automaticRetry: false, soakSeconds: SOAK / 1000 };
    },
    async finishInverse({ expectedPlanSha256, native }) {
      const p = await plan(expectedPlanSha256), lease = readLease(), ackRaw = read(file('ack.inverse.json'));
      const ack = JSON.parse(ackRaw);
      if (lease) owns(p); else check(fs.existsSync(file('finish.inverse.json')), 'LCI_INVERSE_LEASE_ABSENT');
      check(ack.planSha256 === expectedPlanSha256 && ack.targetSha256 === p.targetSha256
        && ack.attemptSha256 === sha256(read(file('attempt.inverse.json'))), 'LCI_INVERSE_ACK_BINDING');
      if (lease) check(lease.phase === 'inverse-soaking' && lease.ackSha256 === sha256(ackRaw)
        && now() >= lease.expiresAtMs && lease.expiresAtMs - lease.acquiredAtMs === SOAK
        && Date.parse(native.requestedAt) >= lease.expiresAtMs, 'LCI_INVERSE_SOAK_INCOMPLETE');
      target(p.targetSha256);
      check(sha256(live()) === ack.diskSha256, 'LCI_INVERSE_FINISH_DISK');
      evidence(native, p.sourceGraphSha256, p.sourceOrderedGraphSha256, ack.revisionSha256);
      const receipt = { planSha256: expectedPlanSha256, ackSha256: sha256(ackRaw),
        diskSha256: ack.diskSha256, revisionSha256: ack.revisionSha256 };
      if (fs.existsSync(file('finish.inverse.json'))) check(JSON.stringify(json('finish.inverse.json')) === JSON.stringify(receipt), 'LCI_INVERSE_FINISH_RECEIPT');
      else write('finish.inverse.json', receipt);
      if (lease) { owns(p); fs.unlinkSync(leasePath); syncDirectory(root); }
      return { status: 'INVERSE_FINISHED', leaseReleased: true, nodeRedRestarted: false };
    },
    async finish({ expectedPlanSha256, native }) {
      const p = await plan(expectedPlanSha256), lease = readLease(), ackRaw = read(file('ack.json')), ack = JSON.parse(ackRaw);
      check(ack.kind === KIND && ack.planSha256 === expectedPlanSha256 && ack.targetSha256 === p.targetSha256
        && ack.sourceOrderedGraphSha256 === p.sourceOrderedGraphSha256 && ack.candidateOrderedGraphSha256 === p.candidateOrderedGraphSha256
        && ack.editorOrderedGraphSha256 === p.editorOrderedGraphSha256
        && ['native-http-200', 'observed-post-adoption'].includes(ack.ackMode)
        && ack.attemptSha256 === sha256(read(file('attempt.json'))), 'LCI_ACK_BINDING');
      const receiptExists = fs.existsSync(file('finish.json'));
      if (lease) { const owned = owns(p); check(owned.phase === 'soaking' && owned.ackSha256 === sha256(ackRaw)
        && now() >= owned.expiresAtMs && owned.expiresAtMs - owned.acquiredAtMs === SOAK
        && Date.parse(native.requestedAt) >= owned.expiresAtMs, 'LCI_SOAK_INCOMPLETE'); }
      else check(receiptExists, 'LCI_LEASE_ABSENT');
      await post(p, native); check(native.revisionSha256 === ack.revisionSha256 && sha256(live()) === ack.diskSha256, 'LCI_FINISH_DRIFT');
      const receipt = { kind: KIND, planSha256: expectedPlanSha256, ackSha256: sha256(ackRaw), targetSha256: p.targetSha256,
        candidateSha256: p.candidateSha256, diskSha256: ack.diskSha256, revisionSha256: ack.revisionSha256 };
      if (receiptExists) check(JSON.stringify(json('finish.json')) === JSON.stringify(receipt), 'LCI_FINISH_RECEIPT_DRIFT'); else write('finish.json', receipt);
      if (lease) { owns(p); fs.unlinkSync(leasePath); syncDirectory(root); }
      return { status: 'FINISHED', leaseReleased: true, nodeRedRestarted: false, injectInvoked: false };
    },
    async abort({ expectedPlanSha256, native }) {
      const p = await plan(expectedPlanSha256), lease = readLease();
      if (lease) owns(p); else check(fs.existsSync(file('abort.json')), 'LCI_LEASE_ABSENT');
      check(!fs.existsSync(file('attempt.json')), 'LCI_ATTEMPT_MAY_HAVE_EFFECT'); await pre(p, native);
      const receipt = { kind: KIND, planSha256: expectedPlanSha256, sourceSha256: p.sourceSha256, targetSha256: p.targetSha256 };
      if (!fs.existsSync(file('abort.json'))) write('abort.json', receipt);
      else check(JSON.stringify(json('abort.json')) === JSON.stringify(receipt), 'LCI_ABORT_RECEIPT_DRIFT');
      await pre(p, native);
      if (lease) { owns(p); fs.unlinkSync(leasePath); syncDirectory(root); }
      return { status: 'ABORTED_BEFORE_ATTEMPT', leaseReleased: true };
    },
  };
}

async function main() {
  check(process.getuid() === 0, 'LCI_ROOT_REQUIRED');
  const [action, stage] = process.argv.slice(2);
  check(process.argv.length === 4 && ['inspect', 'prepare', 'reserve', 'begin', 'confirm', 'reconcile', 'adopt', 'finish', 'abort', 'beginInverse', 'confirmInverse', 'adoptInverse', 'finishInverse'].includes(action), 'LCI_ARGUMENTS');
  const operation = createCollectorNativeOperation({ stage });
  const input = action === 'inspect' ? undefined : JSON.parse(fs.readFileSync(0, 'utf8'));
  console.log(JSON.stringify(await operation[action](input)));
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    check(process.getuid() === 0, 'LCI_ROOT_REQUIRED');
    if (process.env.PADLHUB_COLLECTOR_LOCK_HELD !== '1') {
      const lock = path.join(ROOT, '.padlhub-reviewed-flow-deploy.lock');
      const fd = fs.openSync(lock, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
      try { const st = fs.fstatSync(fd); check(st.isFile() && st.uid === 0 && st.nlink === 1 && (st.mode & 0o777) === 0o600, 'LCI_LOCK_CUSTODY'); } finally { fs.closeSync(fd); }
      // Input/output are inherited: only the child reads safe operator evidence.
      const result = spawnSync('flock', ['-E', '75', '-n', lock, process.execPath, fileURLToPath(import.meta.url), ...process.argv.slice(2)],
        { env: { ...process.env, PADLHUB_COLLECTOR_LOCK_HELD: '1' }, stdio: 'inherit', timeout: 60000 });
      check(!result.error && Number.isInteger(result.status), 'LCI_LOCK_REFUSED'); process.exitCode = result.status;
    } else await main();
  } catch { console.error('Collector native operation refused; preserve stage and lease for guarded reconciliation'); process.exitCode = 1; }
}
