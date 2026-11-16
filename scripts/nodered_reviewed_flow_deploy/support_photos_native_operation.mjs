#!/usr/bin/env node
// Root custody for one original, authenticated native-editor request. This file
// never calls /flows, writes flows.json, exports credentials or restarts a process.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sha256 } from '../nodered_max_outbox_resume.mjs';
import { buildSupportPhotoTransition, supportPhotoOperations } from '../nodered_support_photos_release.mjs';
import { buildExactGraphContract, validateReviewedFlowContract, writeFileExclusiveDurable,
  writeFileExclusiveAtomicDurable, recoverAtomicExclusivePublication, atomicWrite, syncDirectory } from './runtime_contract.mjs';
import { support_photosGraphHash, support_photosOrderedGraphHash } from './support_photos_body_preserver.mjs';
import { buildSupportPhotosBrowserGuard } from './support_photos_browser_guard.mjs';

const ROOT = '/root/.node-red', LEASE = '.padlhub-reviewed-flow-deploy.lease.json';
const SOAK = 900000;
const ADAPTER_FILES = ['README.md', 'max-integration-config.js', 'max-media-config.js', 'max-media.js',
  'max-outbox-receipt.js', 'max-outbox-send.html', 'max-outbox-send.js', 'package.json'];
const hex = s => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
const check = (ok, code) => { if (!ok) throw new Error(code); };
const bytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
export function support_photosOperationCodeHash() {
  return sha256(Buffer.concat(['support_photos_native_operation.mjs', 'support_photos_body_preserver.mjs',
    'support_photos_browser_guard.mjs', 'runtime_contract.mjs', '../nodered_support_photos_release.mjs',
    '../prepare_support_photos.mjs', '../nodered_max_outbox_resume.mjs',
    ...['fn_support_event_prepare', 'fn_support_photo_prepare', 'fn_support_photo_prepared',
      'fn_support_photo_resolve', 'fn_support_photo_resolved', 'fn_support_photo_error',
      'fn_support_photo_debug', 'fn_support_photo_event_response'].map(n => '../nodered_support_nodes/' + n + '.js'),
    '../nodered_max_nodes/fn_max_legacy_photo_dispatch_prepare.js',
    ...ADAPTER_FILES.map(name => '../../node-red/max-outbox-adapter/' + name)]
    .map(name => fs.readFileSync(new URL(name, import.meta.url)))));
}
const predecessors = { install: ['pause'], resume: ['install'], 'pause-photo': ['resume'], recover: ['install', 'pause-photo'] };
const contractInputs = (source, candidate, purpose) => purpose === 'recover'
  ? { liveBytes: candidate, candidateBytes: source } : { liveBytes: source, candidateBytes: candidate };
export function readSupportPhotosTarget() {
  const list = JSON.parse(execFileSync('pm2', ['jlist'], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }));
  const found = list.filter(p => p.name === 'node-red'); check(found.length === 1, 'PHOTON_PROCESS');
  const p = found[0], env = p.pm2_env;
  check(env.status === 'online' && Number.isSafeInteger(p.pid) && p.pid > 0
    && Number.isSafeInteger(env.restart_time) && fs.statSync(`/proc/${p.pid}`).uid === 0, 'PHOTON_PROCESS_OWNER');
  const listeners = execFileSync('ss', ['-ltnpH'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] })
    .split('\n').filter(l => /:1880\s/.test(l));
  check(listeners.length === 1 && listeners[0].includes(`pid=${p.pid},`), 'PHOTON_LISTENER_OWNER');
  const settings = `${ROOT}/settings.js`, st = fs.lstatSync(settings);
  check(st.isFile() && !st.isSymbolicLink() && st.uid === 0 && st.nlink === 1 && !(st.mode & 0o022), 'PHOTON_SETTINGS');
  const entry = fs.realpathSync(env.pm_exec_path), version = JSON.parse(fs.readFileSync(path.join(path.dirname(entry), 'package.json'))).version;
  check(version === '4.0.9', 'PHOTON_RUNTIME_VERSION');
  const adapter = path.join(ROOT, 'node_modules/node-red-contrib-padlhub-max-outbox');
  const adapterDir = fs.lstatSync(adapter);
  check(adapterDir.isDirectory() && !adapterDir.isSymbolicLink() && fs.realpathSync(adapter) === adapter
    && adapterDir.uid === 0 && !(adapterDir.mode & 0o022), 'PHOTON_ADAPTER_CUSTODY');
  check(JSON.stringify(fs.readdirSync(adapter).sort()) === JSON.stringify([...ADAPTER_FILES].sort()), 'PHOTON_ADAPTER_FILESET');
  const adapterHashes = Object.fromEntries(ADAPTER_FILES.map(name => {
    const file = path.join(adapter, name), info = fs.lstatSync(file);
    check(info.isFile() && !info.isSymbolicLink() && info.uid === 0 && info.nlink === 1
      && !(info.mode & 0o022), 'PHOTON_ADAPTER_FILE_CUSTODY');
    const hash = sha256(fs.readFileSync(file));
    check(hash === sha256(fs.readFileSync(new URL('../../node-red/max-outbox-adapter/' + name, import.meta.url))), 'PHOTON_ADAPTER_SOURCE_DRIFT');
    return [name, hash];
  }));
  const mediaFile = '/etc/phab-traffic/max-media-integration.json', mediaInfo = fs.lstatSync(mediaFile);
  const mediaParent = fs.lstatSync(path.dirname(mediaFile));
  check(mediaInfo.isFile() && !mediaInfo.isSymbolicLink() && mediaInfo.uid === 0 && mediaInfo.nlink === 1
    && (mediaInfo.mode & 0o7777) === 0o600 && mediaInfo.size > 0 && mediaInfo.size <= 2048
    && fs.realpathSync(path.dirname(mediaFile)) === path.dirname(mediaFile)
    && mediaParent.isDirectory() && !mediaParent.isSymbolicLink() && mediaParent.uid === 0
    && !(mediaParent.mode & 0o022), 'PHOTON_MEDIA_CONFIG_CUSTODY');
  return sha256(bytes({ machine: sha256(fs.readFileSync('/etc/machine-id')), pid: p.pid, restarts: env.restart_time,
    executable: fs.readlinkSync(`/proc/${p.pid}/exe`), cwd: fs.readlinkSync(`/proc/${p.pid}/cwd`),
    command: sha256(fs.readFileSync(`/proc/${p.pid}/cmdline`)), entry, settings: sha256(fs.readFileSync(settings)), version,
    adapter: adapterHashes, mediaConfigSha256: sha256(fs.readFileSync(mediaFile)) }));
}

export function createSupportPhotosNativeOperation({ stage, purpose = 'install', root = ROOT, uid = 0, gid = 0,
  getUid = () => process.getuid(), now = Date.now, readTarget = readSupportPhotosTarget,
  codeHash = support_photosOperationCodeHash } = {}) {
  check(['pause', 'install', 'resume', 'pause-photo', 'recover'].includes(purpose), 'PHOTON_PURPOSE');
  const KIND = 'support-photos-native-' + purpose;
  const protection = { uid, gid, mode: 0o600 };
  check(getUid() === uid && path.dirname(stage) === root
    && new RegExp('^\\.padlhub-support_photos-' + purpose + '-stage-\\d{8}T\\d{6}Z-\\d+$').test(path.basename(stage)), 'PHOTON_STAGE_PATH');
  const dir = fs.lstatSync(stage);
  check(dir.isDirectory() && !dir.isSymbolicLink() && fs.realpathSync(stage) === stage
    && dir.uid === uid && dir.gid === gid && (dir.mode & 0o777) === 0o700, 'PHOTON_STAGE_CUSTODY');
  const file = name => path.join(stage, name), leasePath = path.join(root, LEASE);
  const read = (name, modes = [0o600], links = [1]) => {
    const fd = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const st = fs.fstatSync(fd), link = fs.lstatSync(name);
      check(st.isFile() && links.includes(st.nlink) && st.uid === uid && st.gid === gid && modes.includes(st.mode & 0o777)
        && st.ino === link.ino && st.dev === link.dev, 'PHOTON_FILE_CUSTODY');
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
      check(value.formatVersion === 4 && value.kind === KIND && value.stage === stage, 'PHOTON_FOREIGN_PARTIAL_LEASE');
      recoverAtomicExclusivePublication(leasePath, protection);
    }
    const value = JSON.parse(read(leasePath));
    if (value.formatVersion === 2) check(typeof value.deploymentId === 'string'
      && /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/.test(value.deploymentId)
      && typeof value.token === 'string' && value.token.trim().length > 0
      && ['applying', 'soaking', 'rollback-restart-required'].includes(value.phase)
      && Number.isSafeInteger(value.acquiredAtMs) && Number.isSafeInteger(value.expiresAtMs)
      && value.expiresAtMs > value.acquiredAtMs && hex(value.sourceSha256) && hex(value.candidateSha256), 'PHOTON_FOREIGN_LEASE_INVALID');
    return value;
  };
  const writeLease = value => atomicWrite(leasePath, bytes(value), { uid, gid });
  const target = expected => {
    const actual = readTarget(); check(hex(actual) && (!expected || actual === expected), 'PHOTON_TARGET_DRIFT'); return actual;
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
      && Date.parse(value.observedAt) <= now() && now() - Date.parse(value.observedAt) <= 30000, 'PHOTON_NATIVE_EVIDENCE');
    return value;
  };
  const previousProof = async p => {
    check(path.dirname(p.previousStage || '') === root
      && /^\.padlhub-support_photos-(pause|install|resume|pause-photo)-stage-\d{8}T\d{6}Z-\d+$/.test(path.basename(p.previousStage)), 'PHOTON_PREVIOUS_STAGE');
    const st = fs.lstatSync(p.previousStage);
    check(st.isDirectory() && !st.isSymbolicLink() && fs.realpathSync(p.previousStage) === p.previousStage
      && st.uid === uid && st.gid === gid && (st.mode & 0o777) === 0o700, 'PHOTON_PREVIOUS_CUSTODY');
    const raw = read(path.join(p.previousStage, 'plan.json')), prior = JSON.parse(raw);
    check(predecessors[purpose]?.includes(prior.purpose) && prior.kind === 'support-photos-native-' + prior.purpose
      && sha256(raw) === p.previousPlanSha256 && prior.codeSha256 === codeHash()
      && prior.sourceCommit === p.sourceCommit && prior.targetSha256 === p.targetSha256
      && prior.originalSha256 === p.originalSha256, 'PHOTON_PREVIOUS_PLAN');
    const original = read(path.join(p.previousStage, 'original.flow.json'));
    const source = read(path.join(p.previousStage, 'source.flow.json')), candidate = read(path.join(p.previousStage, 'candidate.flow.json'));
    check(sha256(original) === p.originalSha256 && prior.sourceSha256 === sha256(source)
      && prior.candidateSha256 === sha256(candidate), 'PHOTON_PREVIOUS_BACKUP');
    const built = buildSupportPhotoTransition(source, original, prior.originalPins, prior.purpose);
    check(await support_photosOrderedGraphHash(built.flow) === prior.candidateOrderedGraphSha256
      && await support_photosOrderedGraphHash(JSON.parse(candidate)) === prior.candidateOrderedGraphSha256
      && await support_photosOrderedGraphHash(JSON.parse(source)) === prior.sourceOrderedGraphSha256
      && await support_photosGraphHash(built.flow) === prior.candidateGraphSha256
      && prior.operationsSha256 === sha256(JSON.stringify(supportPhotoOperations(JSON.parse(source), built.flow, prior.purpose))), 'PHOTON_PREVIOUS_CANDIDATE');
    validateReviewedFlowContract({ ...contractInputs(source, candidate, prior.purpose), contract: prior.contract });
    const ackRaw = read(path.join(p.previousStage, 'ack.json')), ack = JSON.parse(ackRaw);
    const attemptRaw = read(path.join(p.previousStage, 'attempt.json')), attempt = JSON.parse(attemptRaw);
    check(ack.kind === prior.kind && ack.planSha256 === p.previousPlanSha256 && ack.targetSha256 === p.targetSha256
      && ack.attemptSha256 === sha256(attemptRaw) && attempt.planSha256 === p.previousPlanSha256
      && attempt.preRevisionSha256 === prior.preRevisionSha256
      && ack.diskSha256 === p.sourceSha256 && ack.candidateOrderedGraphSha256 === p.sourceOrderedGraphSha256
      && ack.revisionSha256 === p.preRevisionSha256
      && ack.sourceOrderedGraphSha256 === prior.sourceOrderedGraphSha256
      && ['native-http-200', 'observed-post-adoption'].includes(ack.ackMode), 'PHOTON_PREVIOUS_ACK');
    return { plan: prior, ackRaw, original };
  };
  const validatePreviousLease = async (p, prior) => {
    const proof = await previousProof(p);
    check(prior?.formatVersion === 4 && prior.kind === proof.plan.kind
      && prior.stage === p.previousStage && prior.planSha256 === p.previousPlanSha256
      && prior.phase === 'soaking' && prior.ackSha256 === sha256(proof.ackRaw)
      && prior.codeSha256 === p.codeSha256 && prior.targetSha256 === p.targetSha256
      && prior.sourceSha256 === proof.plan.sourceSha256 && prior.candidateSha256 === proof.plan.candidateSha256
      && Number.isSafeInteger(prior.acquiredAtMs) && prior.acquiredAtMs <= now()
      && Number.isSafeInteger(prior.expiresAtMs) && prior.expiresAtMs - prior.acquiredAtMs === SOAK,
    'PHOTON_PREVIOUS_LEASE_REQUIRED');
  };
  const validateFinishedPrevious = async p => {
    check(purpose === 'pause-photo', 'PHOTON_FINISHED_PREDECESSOR_PURPOSE');
    const proof = await previousProof(p), ack = JSON.parse(proof.ackRaw);
    check(proof.plan.purpose === 'resume', 'PHOTON_FINISHED_PREDECESSOR_PURPOSE');
    const raw = read(path.join(p.previousStage, 'finish.json')), receipt = JSON.parse(raw);
    const expected = { kind: proof.plan.kind, planSha256: p.previousPlanSha256, ackSha256: sha256(proof.ackRaw),
      targetSha256: p.targetSha256, candidateSha256: proof.plan.candidateSha256,
      diskSha256: ack.diskSha256, revisionSha256: ack.revisionSha256 };
    check(JSON.stringify(receipt) === JSON.stringify(expected)
      && (!p.previousFinishedSha256 || p.previousFinishedSha256 === sha256(raw)), 'PHOTON_FINISHED_PREDECESSOR_DRIFT');
    return sha256(raw);
  };
  const plan = async expected => {
    const raw = read(file('plan.json')); check(hex(expected) && sha256(raw) === expected, 'PHOTON_PLAN_HASH');
    const p = JSON.parse(raw);
    check(p.kind === KIND && p.purpose === purpose && p.formatVersion === 2 && hex(p.editorOrderedGraphSha256) && p.codeSha256 === codeHash()
      && /^[a-f0-9]{40}$/.test(p.sourceCommit), 'PHOTON_PLAN_IDENTITY');
    const source = read(file('source.flow.json')), candidate = read(file('candidate.flow.json'));
    check(sha256(source) === p.sourceSha256 && sha256(candidate) === p.candidateSha256, 'PHOTON_BACKUP_DRIFT');
    const original = read(file('original.flow.json')); check(sha256(original) === p.originalSha256, 'PHOTON_ORIGINAL_DRIFT');
    const built = buildSupportPhotoTransition(source, original, p.originalPins, purpose);
    check(p.nativeDiskSha256 === sha256(JSON.stringify(built.flow, null, 4)), 'PHOTON_NATIVE_CANDIDATE_DRIFT');
    check(await support_photosOrderedGraphHash(JSON.parse(source)) === p.sourceOrderedGraphSha256
      && await support_photosOrderedGraphHash(built.flow) === p.candidateOrderedGraphSha256
      && await support_photosOrderedGraphHash(JSON.parse(candidate)) === p.candidateOrderedGraphSha256
      && await support_photosGraphHash(built.flow) === p.candidateGraphSha256
      && await support_photosGraphHash(JSON.parse(candidate)) === p.candidateGraphSha256, 'PHOTON_CANDIDATE_DRIFT');
    validateReviewedFlowContract({ ...contractInputs(source, candidate, purpose), contract: p.contract });
    const operations = supportPhotoOperations(JSON.parse(source), built.flow, purpose);
    const allowed = operations.edits.map(e => ({ id: e.id, fields: [...Object.keys(e.set), ...e.unset].sort() }));
    check(JSON.stringify(p.contract.allowedChanges.map(({id,fields})=>({id,fields}))) === JSON.stringify(allowed.sort((a,b)=>a.id.localeCompare(b.id)))
      && JSON.stringify(p.contract.allowedAdditions.map(x=>x.id).sort()) === JSON.stringify((purpose === 'recover' ? [...operations.removals] : operations.additions.map(n=>n.id)).sort())
      && p.operationsSha256 === sha256(JSON.stringify(operations)), 'PHOTON_CONTRACT_SCOPE');
    if (purpose !== 'pause') await previousProof(p);
    if (p.previousFinishedSha256) await validateFinishedPrevious(p);
    target(p.targetSha256); return p;
  };
  const owns = p => {
    const lease = readLease();
    check(lease?.formatVersion === 4 && lease.kind === KIND && lease.stage === stage
      && lease.planSha256 === sha256(read(file('plan.json'))) && lease.codeSha256 === p.codeSha256
      && lease.targetSha256 === p.targetSha256 && lease.sourceSha256 === p.sourceSha256
      && lease.candidateSha256 === p.candidateSha256, 'PHOTON_LEASE_BINDING');
    return lease;
  };
  const pre = async (p, native) => {
    target(p.targetSha256); check(sha256(live()) === p.sourceSha256, 'PHOTON_SOURCE_DRIFT');
    evidence(native, p.sourceGraphSha256, p.sourceOrderedGraphSha256, p.preRevisionSha256, p.editorOrderedGraphSha256);
  };
  const post = async (p, native) => {
    target(p.targetSha256); const raw = live(), flow = JSON.parse(raw);
    check(sha256(raw) === p.nativeDiskSha256, 'PHOTON_POST_DISK_ENCODING');
    check(await support_photosGraphHash(flow) === p.candidateGraphSha256
      && await support_photosOrderedGraphHash(flow) === p.candidateOrderedGraphSha256, 'PHOTON_POST_GRAPH');
    evidence(native, p.candidateGraphSha256, p.candidateOrderedGraphSha256); check(native.revisionSha256 !== p.preRevisionSha256, 'PHOTON_REVISION_UNCHANGED');
  };
  const confirm = async (p, native, ackMode, ackAt) => {
    const lease = owns(p); check(['reserved', 'owner-decision'].includes(lease.phase), 'PHOTON_CONFIRM_PHASE');
    const attempt = json('attempt.json');
    check(attempt.planSha256 === lease.planSha256 && attempt.preRevisionSha256 === p.preRevisionSha256
      && attempt.sourceOrderedGraphSha256 === p.sourceOrderedGraphSha256 && attempt.candidateOrderedGraphSha256 === p.candidateOrderedGraphSha256
      && attempt.editorOrderedGraphSha256 === p.editorOrderedGraphSha256, 'PHOTON_ATTEMPT_BINDING');
    await post(p, native);
    check(now() <= attempt.notAfterMs && Date.parse(native.requestedAt) >= ackAt && ackAt >= attempt.requestedAtMs, 'PHOTON_ACK_TIMING');
    const ack = { kind: KIND, planSha256: lease.planSha256, attemptSha256: sha256(read(file('attempt.json'))),
      sourceOrderedGraphSha256: p.sourceOrderedGraphSha256, candidateOrderedGraphSha256: p.candidateOrderedGraphSha256,
      editorOrderedGraphSha256: p.editorOrderedGraphSha256,
      ackMode, targetSha256: p.targetSha256, diskSha256: sha256(live()), revisionSha256: native.revisionSha256 };
    if (fs.existsSync(file('ack.json'))) check(JSON.stringify(json('ack.json')) === JSON.stringify(ack), 'PHOTON_ACK_DRIFT');
    else write('ack.json', ack);
    writeLease({ ...lease, phase: 'soaking', ackSha256: sha256(read(file('ack.json'))), acquiredAtMs: now(), expiresAtMs: now() + SOAK });
    return { status: 'SOAKING', soakSeconds: SOAK / 1000, candidateSha256: p.candidateSha256, nodeRedRestarted: false, injectInvoked: false };
  };
  return {
    inspect() { return { sourceSha256: sha256(live()), targetSha256: target(), codeSha256: codeHash(), authority: 'native-editor-root-custody' }; },
    async prepare({ expectedSourceSha256, expectedTargetSha256, expectedCodeSha256, sourceCommit, originalPins, previousStage, previousPlanSha256, native }) {
      check(hex(expectedSourceSha256) && hex(expectedTargetSha256) && hex(expectedCodeSha256)
        && codeHash() === expectedCodeSha256 && /^[a-f0-9]{40}$/.test(sourceCommit), 'PHOTON_PREPARE_PINS');
      target(expectedTargetSha256); const source = live(); check(sha256(source) === expectedSourceSha256, 'PHOTON_SOURCE_DRIFT');
      const flow = JSON.parse(source); evidence(native, await support_photosGraphHash(flow), await support_photosOrderedGraphHash(flow));
      if (purpose !== 'pause') {
        check(typeof previousStage === 'string' && path.dirname(previousStage) === root
          && /^\.padlhub-support_photos-(pause|install|resume|pause-photo)-stage-\d{8}T\d{6}Z-\d+$/.test(path.basename(previousStage)), 'PHOTON_PREVIOUS_STAGE');
        const previousDirectory = fs.lstatSync(previousStage);
        check(previousDirectory.isDirectory() && !previousDirectory.isSymbolicLink() && fs.realpathSync(previousStage) === previousStage
          && previousDirectory.uid === uid && previousDirectory.gid === gid && (previousDirectory.mode & 0o777) === 0o700, 'PHOTON_PREVIOUS_CUSTODY');
      }
      const original = purpose === 'pause' ? source : read(path.join(previousStage, 'original.flow.json'));
      const pins = purpose === 'pause' ? originalPins : JSON.parse(read(path.join(previousStage, 'plan.json'))).originalPins;
      const built = buildSupportPhotoTransition(source, original, pins, purpose), candidate = bytes(built.flow);
      const operations = supportPhotoOperations(flow, built.flow, purpose);
      const allowed = operations.edits.map(e => ({ id: e.id, fields: [...Object.keys(e.set), ...e.unset].sort() }));
      const contract = buildExactGraphContract({ ...contractInputs(source, candidate, purpose), deploymentId: 'support-photos-' + purpose,
        allowedChanges: allowed, allowedAdditionIds: purpose === 'recover' ? operations.removals : operations.additions.map(n=>n.id) });
      validateReviewedFlowContract({ ...contractInputs(source, candidate, purpose), contract });
      const p = { kind: KIND, purpose, previousStage, previousPlanSha256, originalSha256: sha256(original), operationsSha256: sha256(JSON.stringify(operations)), formatVersion: 2, sourceCommit, originalPins: structuredClone(pins), codeSha256: expectedCodeSha256, targetSha256: expectedTargetSha256,
        sourceSha256: sha256(source), candidateSha256: sha256(candidate), nativeDiskSha256: sha256(JSON.stringify(built.flow, null, 4)), sourceGraphSha256: await support_photosGraphHash(flow),
        sourceOrderedGraphSha256: await support_photosOrderedGraphHash(flow), candidateOrderedGraphSha256: await support_photosOrderedGraphHash(built.flow),
        editorOrderedGraphSha256: native.editorOrderedGraphSha256,
        candidateGraphSha256: await support_photosGraphHash(built.flow), preRevisionSha256: native.revisionSha256,
        preparedAtMs: now(), contract, browserGuardSha256: sha256(buildSupportPhotosBrowserGuard()) };
      if (purpose !== 'pause') {
        if (fs.existsSync(leasePath)) {
          const priorRaw = read(leasePath); await validatePreviousLease(p, JSON.parse(priorRaw));
          p.predecessorLeaseSha256 = sha256(priorRaw);
        } else p.previousFinishedSha256 = await validateFinishedPrevious(p);
      }
      await pre(p, native);
      writeFileExclusiveDurable(file('original.flow.json'), original, protection);
      writeFileExclusiveDurable(file('source.flow.json'), source, protection);
      writeFileExclusiveDurable(file('candidate.flow.json'), candidate, protection); write('plan.json', p);
      return { status: 'PREPARED', planSha256: sha256(read(file('plan.json'))), candidateSha256: p.candidateSha256,
        changedNodeCount: built.changedIds.length, addedNodeCount: built.addedIds.length, removedNodeCount: built.removedIds.length, liveFlowWritten: false };
    },
    async reserve({ expectedPlanSha256, confirmation, native }) {
      check(confirmation === 'RESERVE_SUPPORT_PHOTOS_' + purpose.toUpperCase() + '_NATIVE_NO_RESTART_147', 'PHOTON_RESERVE_CONFIRMATION');
      const p = await plan(expectedPlanSha256); await pre(p, native);
      check(now() >= p.preparedAtMs && now() - p.preparedAtMs <= 1800000, 'PHOTON_PLAN_STALE');
      const previous = readLease();
      if (purpose !== 'pause') {
        if (p.previousFinishedSha256) {
          check(previous === null, 'PHOTON_FINISHED_PREDECESSOR_FOREIGN_LEASE');
          await validateFinishedPrevious(p);
        } else {
          await validatePreviousLease(p, previous);
          check(hex(p.predecessorLeaseSha256) && sha256(read(leasePath)) === p.predecessorLeaseSha256, 'PHOTON_PREDECESSOR_DRIFT');
        }
      } else if (previous) {
        check(previous.formatVersion === 2 && previous.phase === 'soaking' && Number.isSafeInteger(previous.expiresAtMs)
          && previous.expiresAtMs <= now() && previous.candidateSha256 === p.sourceSha256, 'PHOTON_EXISTING_LEASE');
      }
      if (previous) writeFileExclusiveDurable(file('predecessor.lease.json'), read(leasePath), protection);
      write('reserve.json', { kind: KIND, planSha256: expectedPlanSha256, sourceSha256: p.sourceSha256,
        candidateSha256: p.candidateSha256, targetSha256: p.targetSha256, reservedAtMs: now() });
      const lease = { formatVersion: 4, kind: KIND, stage, phase: 'reserved', planSha256: expectedPlanSha256,
        codeSha256: p.codeSha256, targetSha256: p.targetSha256, sourceSha256: p.sourceSha256,
        candidateSha256: p.candidateSha256, acquiredAtMs: now(), expiresAtMs: now() + SOAK };
      if (previous) writeLease(lease); else writeFileExclusiveAtomicDurable(leasePath, bytes(lease), protection);
      try { await pre(p, native); } catch { writeLease({ ...lease, phase: 'owner-decision' }); throw new Error('PHOTON_RESERVATION_DRIFT_RETAINED'); }
      return { status: 'RESERVED', liveFlowWritten: false, nodeRedRestarted: false };
    },
    async begin({ expectedPlanSha256, native }) {
      const p = await plan(expectedPlanSha256), lease = owns(p); await pre(p, native);
      check(lease.phase === 'reserved' && lease.expiresAtMs - now() >= 360000, 'PHOTON_RESERVATION_TTL');
      const attempt = { kind: KIND, planSha256: expectedPlanSha256, preRevisionSha256: p.preRevisionSha256,
        sourceOrderedGraphSha256: p.sourceOrderedGraphSha256, candidateOrderedGraphSha256: p.candidateOrderedGraphSha256,
        editorOrderedGraphSha256: p.editorOrderedGraphSha256,
        requestedAtMs: now(), notAfterMs: now() + 300000 };
      write('attempt.json', attempt);
      const guard = buildSupportPhotosBrowserGuard(); check(sha256(guard) === p.browserGuardSha256, 'PHOTON_BROWSER_CODE_DRIFT');
      writeFileExclusiveDurable(file('browser-guard.js'), Buffer.from(guard), protection);
      return { status: 'ONE_ATTEMPT_RESERVED', seal: { protocol: 'support-photos-source-preserving-v1', purpose, operations: supportPhotoOperations(JSON.parse(read(file('source.flow.json'))), JSON.parse(read(file('candidate.flow.json'))), purpose), operationsSha256: p.operationsSha256, planSha256: expectedPlanSha256, attemptSha256: sha256(read(file('attempt.json'))),
        sourceGraphSha256: p.sourceGraphSha256, candidateGraphSha256: p.candidateGraphSha256, nativeDiskSha256: p.nativeDiskSha256,
        sourceOrderedGraphSha256: p.sourceOrderedGraphSha256, candidateOrderedGraphSha256: p.candidateOrderedGraphSha256,
        editorOrderedGraphSha256: p.editorOrderedGraphSha256,
        preRevisionSha256: p.preRevisionSha256, notAfter: new Date(attempt.notAfterMs).toISOString() }, browserGuardSha256: p.browserGuardSha256 };
    },
    async confirm({ expectedPlanSha256, native, audit, httpStatus, ackAt }) {
      const p = await plan(expectedPlanSha256); owns(p);
      check(audit && Object.keys(audit).sort().join(',') === 'attemptSha256,candidateGraphSha256,candidateOrderedGraphSha256,editorOrderedGraphSha256,forwarded,forwardedBodySha256,notAfter,operationsSha256,planSha256,preRevisionSha256,rejected,sourceOrderedGraphSha256,status'
        && audit.status === 'FORWARDED_AWAITING_READBACK' && audit.forwarded === 1 && audit.rejected === 0
        && audit.operationsSha256 === p.operationsSha256 && audit.planSha256 === expectedPlanSha256 && audit.attemptSha256 === sha256(read(file('attempt.json')))
        && audit.candidateGraphSha256 === p.candidateGraphSha256 && audit.preRevisionSha256 === p.preRevisionSha256
        && audit.sourceOrderedGraphSha256 === p.sourceOrderedGraphSha256 && audit.candidateOrderedGraphSha256 === p.candidateOrderedGraphSha256
        && audit.editorOrderedGraphSha256 === p.editorOrderedGraphSha256
        && Date.parse(audit.notAfter) === json('attempt.json').notAfterMs && hex(audit.forwardedBodySha256)
        && httpStatus === 200 && Number.isSafeInteger(ackAt) && ackAt <= now(), 'PHOTON_ACK_INPUT');
      return confirm(p, native, 'native-http-200', ackAt);
    },
    async reconcile({ expectedPlanSha256, native }) {
      const p = await plan(expectedPlanSha256); owns(p); let state = 'UNKNOWN';
      try { await pre(p, native); state = 'PRE'; } catch { try { await post(p, native); state = 'POST'; } catch { /* no authority to release */ } }
      return { status: state, attemptConsumed: fs.existsSync(file('attempt.json')), automaticRetry: false, automaticRelease: false };
    },
    async adopt({ expectedPlanSha256, expectedRevisionSha256, confirmation, native }) {
      check(confirmation === 'ADOPT_OBSERVED_SUPPORT_PHOTOS_' + purpose.toUpperCase() + '_POST_NO_REPLAY_147' && hex(expectedRevisionSha256), 'PHOTON_ADOPT_CONFIRMATION');
      const p = await plan(expectedPlanSha256); owns(p); await post(p, native);
      check(native.revisionSha256 === expectedRevisionSha256, 'PHOTON_ADOPT_REVISION_DRIFT');
      // Explicit adoption attests observed POST, never fabricates an HTTP ACK.
      const attempt = json('attempt.json'); check(attempt.planSha256 === expectedPlanSha256
        && attempt.preRevisionSha256 === p.preRevisionSha256 && attempt.sourceOrderedGraphSha256 === p.sourceOrderedGraphSha256
        && attempt.candidateOrderedGraphSha256 === p.candidateOrderedGraphSha256
        && attempt.editorOrderedGraphSha256 === p.editorOrderedGraphSha256, 'PHOTON_ATTEMPT_BINDING');
      const lease = owns(p);
      check(['reserved', 'owner-decision'].includes(lease.phase), 'PHOTON_ADOPT_PHASE');
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
          && ['native-http-200', 'observed-post-adoption'].includes(old.ackMode), 'PHOTON_ACK_DRIFT');
      } else write('ack.json', ack);
      writeLease({ ...lease, phase: 'soaking', ackSha256: sha256(read(file('ack.json'))), acquiredAtMs: now(), expiresAtMs: now() + SOAK });
      return { status: 'SOAKING', ackMode: 'observed-post-adoption', soakSeconds: SOAK / 1000, automaticRetry: false };
    },
    async finish({ expectedPlanSha256, native }) {
      check(['resume', 'recover'].includes(purpose), 'PHOTON_INTERMEDIATE_FINISH_FORBIDDEN');
      const p = await plan(expectedPlanSha256), lease = readLease(), ackRaw = read(file('ack.json')), ack = JSON.parse(ackRaw);
      check(ack.kind === KIND && ack.planSha256 === expectedPlanSha256 && ack.targetSha256 === p.targetSha256
        && ack.sourceOrderedGraphSha256 === p.sourceOrderedGraphSha256 && ack.candidateOrderedGraphSha256 === p.candidateOrderedGraphSha256
        && ack.editorOrderedGraphSha256 === p.editorOrderedGraphSha256
        && ['native-http-200', 'observed-post-adoption'].includes(ack.ackMode)
        && ack.attemptSha256 === sha256(read(file('attempt.json'))), 'PHOTON_ACK_BINDING');
      const receiptExists = fs.existsSync(file('finish.json'));
      if (lease) { const owned = owns(p); check(owned.phase === 'soaking' && owned.ackSha256 === sha256(ackRaw)
        && now() >= owned.expiresAtMs && owned.expiresAtMs - owned.acquiredAtMs === SOAK
        && Date.parse(native.requestedAt) >= owned.expiresAtMs, 'PHOTON_SOAK_INCOMPLETE'); }
      else check(receiptExists, 'PHOTON_LEASE_ABSENT');
      await post(p, native); check(native.revisionSha256 === ack.revisionSha256 && sha256(live()) === ack.diskSha256, 'PHOTON_FINISH_DRIFT');
      const receipt = { kind: KIND, planSha256: expectedPlanSha256, ackSha256: sha256(ackRaw), targetSha256: p.targetSha256,
        candidateSha256: p.candidateSha256, diskSha256: ack.diskSha256, revisionSha256: ack.revisionSha256 };
      if (receiptExists) check(JSON.stringify(json('finish.json')) === JSON.stringify(receipt), 'PHOTON_FINISH_RECEIPT_DRIFT'); else write('finish.json', receipt);
      if (lease) { owns(p); fs.unlinkSync(leasePath); syncDirectory(root); }
      return { status: 'FINISHED', leaseReleased: true, nodeRedRestarted: false, injectInvoked: false };
    },
    async abort({ expectedPlanSha256, native }) {
      const p = await plan(expectedPlanSha256), lease = readLease();
      let prior = null;
      if (purpose !== 'pause' && !p.previousFinishedSha256) {
        const priorRaw = read(file('predecessor.lease.json'));
        check(hex(p.predecessorLeaseSha256) && sha256(priorRaw) === p.predecessorLeaseSha256, 'PHOTON_PREDECESSOR_DRIFT');
        prior = JSON.parse(priorRaw); await validatePreviousLease(p, prior);
      }
      const returned = prior && fs.existsSync(file('abort.json')) && JSON.stringify(prior) === JSON.stringify(lease);
      if (lease && !returned) owns(p); else check(returned || fs.existsSync(file('abort.json')), 'PHOTON_LEASE_ABSENT');
      check(!fs.existsSync(file('attempt.json')), 'PHOTON_ATTEMPT_MAY_HAVE_EFFECT'); await pre(p, native);
      const receipt = { kind: KIND, planSha256: expectedPlanSha256, sourceSha256: p.sourceSha256, targetSha256: p.targetSha256 };
      if (!fs.existsSync(file('abort.json'))) write('abort.json', receipt);
      else check(JSON.stringify(json('abort.json')) === JSON.stringify(receipt), 'PHOTON_ABORT_RECEIPT_DRIFT');
      await pre(p, native);
      if (lease && !returned) {
        owns(p);
        if (prior) {
          await validatePreviousLease(p, prior);
          writeLease(prior);
        } else { fs.unlinkSync(leasePath); syncDirectory(root); }
      }
      return { status: 'ABORTED_BEFORE_ATTEMPT', leaseReleased: !prior, previousCustodyReturned: Boolean(prior) };
    },
  };
}

async function main() {
  check(process.getuid() === 0, 'PHOTON_ROOT_REQUIRED');
  const [action, stage, purpose] = process.argv.slice(2);
  check(process.argv.length === 5 && ['inspect', 'prepare', 'reserve', 'begin', 'confirm', 'reconcile', 'adopt', 'finish', 'abort'].includes(action), 'PHOTON_ARGUMENTS');
  const operation = createSupportPhotosNativeOperation({ stage, purpose });
  const input = action === 'inspect' ? undefined : JSON.parse(fs.readFileSync(0, 'utf8'));
  console.log(JSON.stringify(await operation[action](input)));
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    check(process.getuid() === 0, 'PHOTON_ROOT_REQUIRED');
    if (process.env.PADLHUB_SUPPORT_PHOTOS_LOCK_HELD !== '1') {
      const lock = path.join(ROOT, '.padlhub-reviewed-flow-deploy.lock');
      const fd = fs.openSync(lock, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
      try { const st = fs.fstatSync(fd); check(st.isFile() && st.uid === 0 && st.nlink === 1 && (st.mode & 0o777) === 0o600, 'PHOTON_LOCK_CUSTODY'); } finally { fs.closeSync(fd); }
      // Input/output are inherited: only the child reads safe operator evidence.
      const result = spawnSync('flock', ['-E', '75', '-n', lock, process.execPath, fileURLToPath(import.meta.url), ...process.argv.slice(2)],
        { env: { ...process.env, PADLHUB_SUPPORT_PHOTOS_LOCK_HELD: '1' }, stdio: 'inherit', timeout: 60000 });
      check(!result.error && Number.isInteger(result.status), 'PHOTON_LOCK_REFUSED'); process.exitCode = result.status;
    } else await main();
  } catch { console.error('SupportPhotos native operation refused; preserve stage and lease for guarded reconciliation'); process.exitCode = 1; }
}
