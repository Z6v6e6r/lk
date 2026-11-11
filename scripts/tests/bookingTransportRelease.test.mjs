import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { TRANSPORT_CASES, proveOwnerTransportContract } from '../lib/bookingTransportLiveContract.mjs';
import { UNPAID_SOURCE_FILES } from '../lib/unpaidWorkerSourceFiles.mjs';
import { deriveWorkerGeneration, materializeFromProof, validateLiveProof, WORKER_GUARD } from '../lib/bookingTransportRelease.mjs';
import { BOOKING_HTTP_ID, BOOKING_ROUTER_ID, prepareBookingTransportRecovery, sha256 } from '../lib/subscriptionBookingTransportRecovery.mjs';
import { buildExactGraphContract } from '../nodered_reviewed_flow_deploy/runtime_contract.mjs';
import { BUNDLE_FILES, verifyBundle } from '../lk1_unpaid_cancel_service/verify_bundle.mjs';
import { lk1VivaBinding } from '../lib/lk1LiveGatewayGuard.mjs';
import { assertUnpaidWorkerIdentity } from '../lib/unpaidWorkerIdentity.mjs';
import { verifyReleasePacket, materializePacket } from '../prepare_booking_transport_release.mjs';

const json = value => JSON.stringify(value, null, 2) + '\n';
const publicOwner = fs.readFileSync(new URL('../nodered_subscription_booking_nodes/fn_subscription_booking_router.js', import.meta.url), 'utf8');
function seed() {
  const flow = [{ id: 'tab', type: 'tab' }, { id: 'in', type: 'http in', z: 'tab', method: 'post', url: '/lk/subscription-bookings', wires: [[BOOKING_HTTP_ID]] },
    { id: BOOKING_HTTP_ID, z: 'tab', type: 'http request', method: 'use', ret: 'obj', senderr: true, wires: [[BOOKING_ROUTER_ID]] },
    { id: BOOKING_ROUTER_ID, z: 'tab', type: 'function', func: 'return msg;', outputs: 8, wires: [] }];
  const source = Buffer.from(JSON.stringify(flow)), sourceSha256 = sha256(source), routerSha256 = sha256('return msg;');
  const prepared = prepareBookingTransportRecovery(source, { sourceSha256, routerSha256 });
  const files = Object.fromEntries(Object.entries(UNPAID_SOURCE_FILES).map(([name, relative]) => [name, fs.readFileSync(relative)]));
  files[WORKER_GUARD] = Buffer.from(files[WORKER_GUARD].toString()
    .replace(/(export const LK1_UNPAID_FLOW_SHA256 = ')[a-f0-9]{64}/, '$1' + sourceSha256)
    .replace(/(export const LK1_UNPAID_GATEWAY_SHA256 = ')[a-f0-9]{64}/, '$1' + routerSha256));
  const baseManifest = { schema: 1, sourceCommit: '1'.repeat(40), files: Object.fromEntries(Object.entries(files).map(([n, b]) => [n, sha256(b)])) };
  const proof = { schema: 1, observedUtc: new Date().toISOString(), sourceSha256, routerSha256, candidateSha256: prepared.candidateSha256,
    sourceNodeCount: flow.length, candidateNodeCount: flow.length + 2,
    exactGraphContract: buildExactGraphContract({ liveBytes: source, candidateBytes: prepared.candidate,
      deploymentId: 'lk1-booking-transport-v1', allowedChanges: [], allowedAdditionIds: prepared.addedNodeIds }),
    additions: JSON.parse(prepared.candidate).slice(-2), unchangedExistingNodes: true,
    ownerCases: TRANSPORT_CASES.map(([step, caller, status]) => ({ step, caller, status, branchReached: true,
      httpDispatches: 0, persistenceDispatches: 0, asynchronousSends: 0 })),
    probes: [{ version: '1', status: 200, supported: true, policy: 'ATOMIC_MANAGED_V1' },
      { version: '2', status: 200, supported: true, policy: 'MANAGED_JOIN_V2' },
      { version: '3', status: 404, supported: false, code: 'BOOKED_OPERATION_OWNER_PROBE_NOT_FOUND' },
      { version: 'training', status: 404, supported: false, code: 'TRAINING_REGISTRATION_OWNER_UNAVAILABLE' }],
    activeFlowMatchesDisk: true, processStable: true, bindingMatchesWorker: true, productionWrites: 0,
    businessRequests: 0, privateSourceExported: false,
    worker: { baseManifest, baseManifestSha256: sha256(json(baseManifest)), unitSha256: baseManifest.files['lk1-unpaid-cancel.service'],
      environmentSha256: 'e'.repeat(64), serviceActive: true, otherWorkerPresent: false } };
  proof.worker.releasePath = '/opt/padlhub-lk1-unpaid-cancel/releases/' + '1'.repeat(40);
  proof.worker.identity = { pid: 42, releasePath: proof.worker.releasePath, effectiveConfigurationMatches: true, dropIns: 0,
    unitSha256: proof.worker.unitSha256, environmentSha256: proof.worker.environmentSha256, manifestSha256: proof.worker.baseManifestSha256 };
  proof.worker.retainedAuthModuleRefs = [{ modulePath: '/opt/padlhub-lk1-unpaid-cancel/releases/' + '3'.repeat(40) + '/lib/lk1FlowReadTokenAuth.cjs', sha256: baseManifest.files['lib/lk1FlowReadTokenAuth.cjs'] }];
  return { source, prepared, proof, files };
}

test('VM proves real canonical pre/post-write branches with no dispatch, preserving the split caller', () => {
  const cases = TRANSPORT_CASES.filter(c => c[0] !== 'lk1_transaction_create');
  // LK1 overlay is tested against the installed body on host; canonical source
  // has no overlay branch. The synthetic wrapper only supplies that fifth case.
  const augmented = publicOwner.replace('if (ctx.step === "profile") {',
    'if (ctx.step === "lk1_transaction_create") { return finishPending(ctx, "fixture overlay"); }\nif (ctx.step === "profile") {');
  const result = proveOwnerTransportContract(augmented);
  assert.equal(result.length, cases.length + 1);
  assert(result.every(r => r.httpDispatches === 0 && r.persistenceDispatches === 0));
  assert.throws(() => proveOwnerTransportContract(augmented.replace('return finishPending(ctx, "fixture overlay");', 'fetch("https://fixture.invalid");')), /CONTRACT_FAILED/);
  assert.throws(() => proveOwnerTransportContract(augmented.replace('return finishPending(ctx, "fixture overlay");', 'return [msg];')), /CONTRACT_FAILED/);
});
test('live readiness rejects missing authority, stale receipts, writes, worker drift and arbitrary delta code', () => {
  assert.equal(validateLiveProof(seed().proof).schema, 1);
  for (const mutate of [
    p => { p.observedUtc = new Date(Date.now() - 1801000).toISOString(); },
    p => { p.processStable = false; }, p => { p.activeFlowMatchesDisk = false; },
    p => { p.businessRequests = 1; }, p => { p.ownerCases[1].httpDispatches = 1; },
    p => { p.probes[0].status = 404; }, p => { p.worker.otherWorkerPresent = true; },
    p => { p.exactGraphContract.allowedChanges.push({ id: 'foreign' }); },
    p => { p.additions[1].func = 'fetch("https://fixture.invalid")'; },
  ]) { const { proof } = seed(); mutate(proof); assert.throws(() => validateLiveProof(proof)); }
});
test('new worker changes only the copied flow pin; old pins, unit, auth module, runner and lockfile stay exact', () => {
  const { proof, files } = seed(), before = Buffer.from(files[WORKER_GUARD]);
  assert.deepEqual(Object.keys(UNPAID_SOURCE_FILES).sort(), [...BUNDLE_FILES].sort());
  const next = deriveWorkerGeneration(proof, files, '2'.repeat(40));
  assert.deepEqual(files[WORKER_GUARD], before);
  assert.deepEqual(next.derivation.changedFiles.map(f => f.name), [WORKER_GUARD]);
  for (const name of BUNDLE_FILES.filter(n => n !== WORKER_GUARD)) assert.deepEqual(next.files[name], files[name]);
  assert(next.files[WORKER_GUARD].toString().includes(`LK1_UNPAID_FLOW_SHA256 = '${proof.candidateSha256}'`));
  assert.equal(next.derivation.gatewaySha256, proof.routerSha256);
  assert.throws(() => deriveWorkerGeneration(proof, { ...files, [WORKER_GUARD]: Buffer.from('foreign') }, '2'.repeat(40)), /SOURCE_MISMATCH/);
  const duplicate = seed(); duplicate.files[WORKER_GUARD] = Buffer.concat([duplicate.files[WORKER_GUARD], duplicate.files[WORKER_GUARD]]);
  duplicate.proof.worker.baseManifest.files[WORKER_GUARD] = sha256(duplicate.files[WORKER_GUARD]);
  duplicate.proof.worker.baseManifestSha256 = sha256(json(duplicate.proof.worker.baseManifest));
  duplicate.proof.worker.identity.manifestSha256 = duplicate.proof.worker.baseManifestSha256;
  assert.throws(() => deriveWorkerGeneration(duplicate.proof, duplicate.files, '2'.repeat(40)), /PIN_DRIFT/);
});
test('running service identity rejects stale symlink/CWD, drop-ins, cached unit, extra args and effective env drift', () => {
  const source = { properties: { ActiveState: 'active', SubState: 'running', MainPID: '42',
    FragmentPath: '/etc/systemd/system/lk1-unpaid-cancel.service', DropInPaths: '', NeedDaemonReload: 'no',
    WorkingDirectory: '/opt/padlhub-lk1-unpaid-cancel/current', EnvironmentFiles: '/etc/padlhub/lk1-unpaid-cancel.env (ignore_errors=yes)',
    ExecStart: '{ path=/usr/local/bin/node ; argv[]=/usr/local/bin/node /opt/padlhub-lk1-unpaid-cancel/current/launch_lk1_unpaid_booking_cancellation.mjs --run ; }' },
    releasePath: '/fixture/release', cwd: '/fixture/release', executable: '/fixture/node', expectedExecutable: '/fixture/node',
    argv: ['/usr/local/bin/node', '/opt/padlhub-lk1-unpaid-cancel/current/launch_lk1_unpaid_booking_cancellation.mjs', '--run'],
    config: { LK1_UNPAID_CANCEL_MODE: 'ENFORCE_NEW' }, processEnvironment: { LK1_UNPAID_CANCEL_MODE: 'ENFORCE_NEW', PRIVATE: 'not-returned' } };
  assert.equal(assertUnpaidWorkerIdentity(source).effectiveConfigurationMatches, true);
  assert(!JSON.stringify(assertUnpaidWorkerIdentity(source)).includes('PRIVATE'));
  for (const mutate of [s => { s.cwd = '/fixture/old'; }, s => { s.properties.DropInPaths = '/foreign'; },
    s => { s.properties.NeedDaemonReload = 'yes'; }, s => { s.argv.push('--once'); },
    s => { s.processEnvironment.LK1_UNPAID_CANCEL_MODE = 'SHADOW'; }, s => { s.properties.ExecStart = 'foreign'; }]) {
    const changed = structuredClone(source); mutate(changed); assert.throws(() => assertUnpaidWorkerIdentity(changed), /IDENTITY_MISMATCH/);
  }
});
test('candidate materializes to the exact attested SHA without losing original rollback bytes', () => {
  const { source, proof, prepared } = seed(), saved = Buffer.from(source);
  assert.deepEqual(materializeFromProof(source, proof), prepared.candidate); assert.deepEqual(source, saved);
  assert.throws(() => materializeFromProof(Buffer.from(source.toString() + ' '), proof), /PREIMAGE/);
  proof.candidateSha256 = 'a'.repeat(64);
  assert.throws(() => materializeFromProof(source, proof), /PROOF_INVALID|DRIFT/);
});
test('actual generated guard accepts only the matching pair; mismatched rollback, PM2 restart and binding changes stop', async t => {
  const { source, proof, files, prepared } = seed(), next = deriveWorkerGeneration(proof, files, '2'.repeat(40));
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'booking-worker-pair-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const save = (name, content, manifest) => {
    const folder = path.join(dir, name); fs.mkdirSync(folder, { mode: 0o700 }); fs.mkdirSync(path.join(folder, 'lib'), { mode: 0o700 });
    for (const [n, b] of Object.entries(content)) fs.writeFileSync(path.join(folder, n), b, { mode: 0o600 });
    fs.writeFileSync(path.join(folder, 'manifest.json'), json(manifest), { mode: 0o600 });
    verifyBundle(folder); return folder;
  };
  const oldDir = save('old', files, proof.worker.baseManifest), newDir = save('new', next.files, next.manifest);
  const old = await import(pathToFileURL(path.join(oldDir, WORKER_GUARD))), current = await import(pathToFileURL(path.join(newDir, WORKER_GUARD)));
  const flowPath = path.join(dir, 'flow.json'), tokenFile = path.join(dir, 'admin.token');
  fs.writeFileSync(tokenFile, 'fixture-admin-token-long-enough', { mode: 0o600 });
  let proc = { name: 'node-red', pid: 10, pm2_env: { status: 'online', pm_uptime: 1000, restart_time: 1,
    VIVA_SERVICE_TOKEN_URL: 'fixture-url', VIVA_SERVICE_CLIENT_ID: 'fixture-client', VIVA_SERVICE_USERNAME: 'fixture-user', VIVA_SERVICE_PASSWORD: ['fixture', 'pass'].join('-') } };
  const options = { flowPath, adminTokenFile: tokenFile, processes: () => [proc], expectedBindingSha: lk1VivaBinding(proc).sha256,
    fetchImpl: async url => url.endsWith('/flows') ? { status: 200, json: async () => ({ rev: 'fixture-rev', flows: JSON.parse(fs.readFileSync(flowPath)) }) }
      : { status: 401, json: async () => ({ details: { code: 'SUBSCRIPTION_BOOKING_AUTH_REQUIRED' } }) } };
  const put = bytes => { fs.writeFileSync(flowPath, bytes); fs.utimesSync(flowPath, new Date(0), new Date(0)); };
  put(source); assert.equal((await old.createLk1LiveGatewayGuard(options)).check(), 'HEALTHY');
  await assert.rejects(current.createLk1LiveGatewayGuard(options), /LIVE_GATEWAY_DRIFT/);
  put(prepared.candidate); await assert.rejects(old.createLk1LiveGatewayGuard(options), /LIVE_GATEWAY_DRIFT/);
  const guard = await current.createLk1LiveGatewayGuard(options); assert.equal(guard.check(), 'HEALTHY');
  proc = { ...proc, pid: 11 }; assert.equal(guard.check(), 'RESTART_PENDING');
  proc.pm2_env.VIVA_SERVICE_PASSWORD = 'different'; assert.equal(guard.check(), 'DRIFT');
  assert.equal(createHash('sha256').update(fs.readFileSync(path.join(oldDir, WORKER_GUARD))).digest('hex'), proof.worker.baseManifest.files[WORKER_GUARD]);
});
test('externally anchored packet verifies both generations, detects artifact tampering and materializes exact rollback bytes', t => {
  const { proof, files, source } = seed(), builderCommit = '2'.repeat(40), generated = deriveWorkerGeneration(proof, files, builderCommit);
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'booking-release-index-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const packet = path.join(dir, 'packet'); fs.mkdirSync(packet, { mode: 0o700 });
  const artifacts = {};
  const save = (name, bytes) => { fs.writeFileSync(path.join(packet, name), bytes, { mode: 0o600 }); artifacts[name] = sha256(bytes); };
  for (const [name, bodies, manifest] of [['worker', generated.files, generated.manifest], ['rollback-worker', files, proof.worker.baseManifest]]) {
    fs.mkdirSync(path.join(packet, name), { mode: 0o700 }); fs.mkdirSync(path.join(packet, name, 'lib'), { mode: 0o700 });
    for (const [file, bytes] of Object.entries(bodies)) save(name + '/' + file, bytes);
    save(name + '/manifest.json', json(manifest));
  }
  save('live-proof.json', json(proof)); save('flow-delta.json', json(proof.additions));
  save('flow-contract.json', json(proof.exactGraphContract)); save('worker-derivation.json', json(generated.derivation));
  const release = { schema: 1, builderCommit, artifacts, liveProofSha256: sha256(json(proof)),
    readyForDeployment: true, readinessScope: 'EXACT_BOOKING_FLOW_AND_UNPAID_WORKER_PAIR',
    requiresFreshPreflightAtApply: true, requiresSeparateProductionApproval: true, productionChanged: false, businessRequests: 0,
    unchangedEnvironmentSha256: proof.worker.environmentSha256, unchangedUnitSha256: proof.worker.unitSha256,
    retainedAuthModuleRefs: proof.worker.retainedAuthModuleRefs,
    sourceFlowSha256: proof.sourceSha256, candidateFlowSha256: proof.candidateSha256,
    workerManifestSha256: generated.derivation.generatedManifestSha256, rollbackManifestSha256: proof.worker.baseManifestSha256 };
  const index = json(release); fs.writeFileSync(path.join(packet, 'release.json'), index, { mode: 0o600 });
  const expected = sha256(index);
  assert.equal(verifyReleasePacket(packet, expected).proof.sourceSha256, proof.sourceSha256);
  assert.throws(() => verifyReleasePacket(packet, 'f'.repeat(64)), /INDEX_DRIFT/);
  const original = path.join(dir, 'original.flow'); fs.writeFileSync(original, source, { mode: 0o600 });
  const materialized = path.join(dir, 'materialized');
  assert.equal(materializePacket(packet, expected, original, materialized).candidateSha256, proof.candidateSha256);
  assert.deepEqual(fs.readFileSync(path.join(materialized, 'source.flow.json')), source);
  const file = path.join(packet, 'flow-delta.json'), saved = fs.readFileSync(file);
  fs.writeFileSync(file, '[]');
  assert.throws(() => verifyReleasePacket(packet, expected), /ARTIFACT_DRIFT/);
  fs.writeFileSync(file, saved); fs.writeFileSync(path.join(packet, 'extra'), 'foreign');
  assert.throws(() => verifyReleasePacket(packet, expected), /ARTIFACT_DRIFT/);
  assert.throws(() => materializePacket(packet, expected, original, path.join(dir, 'must-not-exist')), /ARTIFACT_DRIFT/);
  assert.equal(fs.existsSync(path.join(dir, 'must-not-exist')), false);
});
