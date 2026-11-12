import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildLegacyRetirementContract, validateLegacyRetirementContract } from '../nodered_reviewed_flow_deploy/legacy_retirement_contract.mjs';
import { createReviewedFlowRuntime } from '../nodered_reviewed_flow_deploy/deploy_reviewed_flow_147_remote.mjs';
import { validateLegacyRetirementCli } from '../nodered_reviewed_flow_deploy/legacy_retirement_operation.mjs';
import { buildExactGraphContract, validateReviewedFlowContract } from '../nodered_reviewed_flow_deploy/runtime_contract.mjs';
import { bytes, hash, retirementRuntime } from './fixtures/legacyRetirementRuntime.mjs';

const SOAK = 15 * 60 * 1000;
function validate(f, candidate = f.candidate, contract = f.contract) {
  return validateLegacyRetirementContract({ sourceBytes: f.sourceBytes, candidateBytes: bytes(candidate), contract, bindings: f.bindings });
}
function ordinary(f) {
  return createReviewedFlowRuntime({ liveFlowPath: f.live, stageParent: f.root, backupDirectory: f.backup, deploymentLeasePath: f.lease,
    uid: f.uid, gid: f.gid, getUid: () => f.uid, now: f.now, pm2: f.pm2 });
}
function ordinaryBackups(f, contract = f.contract) {
  const stamp = '20261112T180000+0300'; fs.mkdirSync(f.backup, { recursive: true, mode: 0o700 });
  const flowBackup = path.join(f.backup, `flows-pre-${f.contract.deploymentId}-${stamp}.json`);
  const contractBackup = path.join(f.backup, `contract-${f.contract.deploymentId}-${stamp}.json`);
  f.write(flowBackup, f.sourceBytes); f.write(contractBackup, contract);
  return { flowBackup, contractBackup, deploymentId: f.contract.deploymentId };
}
test('exact removal contract is separate from existing exact-graph and pins the complete artifact', t => {
  const f = retirementRuntime(t);
  assert.deepEqual(validate(f), f.contract); assert.equal(f.contract.removed.length, 14);
  assert.equal(f.contract.rollbackPolicy, 'forbid-source-restore'); assert.equal(f.plan.liveMutationAuthorized, false);
  assert.throws(() => validateReviewedFlowContract({ liveBytes: f.sourceBytes, candidateBytes: f.candidateBytes, contract: f.contract }), /version mismatch/);
  assert.throws(() => buildExactGraphContract({ liveBytes: f.sourceBytes, candidateBytes: f.candidateBytes,
    deploymentId: f.contract.deploymentId, allowedChanges: [{ id: f.flow[0].id, fields: ['d'] }] }), /removed live node/);
  assert.equal(fs.existsSync(f.backup), false); assert.equal(f.restartCalls(), 0);
});
for (const change of ['partial', 'retained-field', 'addition', 'order']) test(`refuses ${change} instead of accepting arbitrary removals`, t => {
  const f = retirementRuntime(t), c = structuredClone(f.candidate);
  if (change === 'partial') c.push(f.flow[0]);
  if (change === 'retained-field') c[0].name = 'unapproved';
  if (change === 'addition') c.push({ id: 'fixture-extra', type: 'debug' });
  if (change === 'order') c.reverse();
  assert.throws(() => validate(f, c), /EXACT_FILTER_ONLY/);
});
test('contract binds machine/process/runtime fingerprint, time window, runner closure and policy', t => {
  const f = retirementRuntime(t);
  for (const patch of [{ rollbackPolicy: 'restore-source' },
    { removed: f.contract.removed.slice(1) }, { sourceSha256: '0'.repeat(64) }, { candidateSha256: '0'.repeat(64) },
    { operationSourceSha256: {} }, { validUntilMs: f.contract.preparedAtMs + 31 * 60 * 1000 }]) {
    assert.throws(() => validate(f, f.candidate, { ...f.contract, ...patch }));
  }
  assert.throws(() => buildLegacyRetirementContract({ sourceBytes: f.sourceBytes, candidateBytes: f.candidateBytes,
    ...f.contract, target: { ...f.contract.target, hostAlias: 'fixture-other-host' }, bindings: f.bindings }), /TARGET/);
  const changedTarget = { ...f.contract, target: { ...f.contract.target, pid: 999 } };
  assert.notEqual(hash(bytes(changedTarget)), f.contractSha256);
  f.write(path.join(f.stage, 'contract.json'), changedTarget);
  assert.throws(() => f.operation.preflight(), /PACKET_DRIFT/);
});
test('preflight/status are read-only; apply removes only cohort and retains non-expiring custody', t => {
  const f = retirementRuntime(t); assert.equal(f.operation.preflight().readOnly, true); assert.equal(f.operation.status().diskState, 'SOURCE');
  assert.equal(fs.existsSync(f.lease), false); assert.equal(fs.existsSync(f.backup), false);
  const r = f.operation.apply(); assert.equal(r.phase, 'SOAKING'); assert.equal(r.runtimeVerified, false);
  assert.deepEqual(fs.readFileSync(f.live), f.candidateBytes); assert.equal(f.restartCalls(), 1);
  const lease = f.read(f.lease); assert.equal(lease.phase, 'applying'); assert.equal(lease.kind, 'legacy-startup-retirement');
  f.advance(2 * SOAK); assert.throws(() => ordinary(f).preflight({}), /lease is active/);
  assert.equal(fs.existsSync(f.lease), true);
  assert.equal(JSON.stringify(r).includes('fixture-private-lease-token'), false);
});
for (const fault of ['machine', 'process', 'runtime', 'expiry', 'flow', 'candidate', 'contract', 'runner']) test(`preflight ${fault} drift causes zero publication/restart`, t => {
  const f = retirementRuntime(t);
  if (fault === 'machine') f.setMachine('c'.repeat(64));
  if (fault === 'process') f.setProcess({ pid: 9000 });
  if (fault === 'runtime') f.setRuntimeFingerprint('c'.repeat(64));
  if (fault === 'expiry') f.advance(31 * 60 * 1000);
  if (fault === 'flow') f.write(f.live, [{ id: 'fixture-foreign', type: 'debug' }]);
  if (fault === 'candidate') f.write(path.join(f.stage, 'candidate.flow.json'), []);
  if (fault === 'contract') f.write(path.join(f.stage, 'contract.json'), {});
  if (fault === 'runner') f.write(path.join(f.stage, 'scripts/nodered_reviewed_flow_deploy/legacy_retirement_operation.mjs'), 'fixture drift');
  const before = fs.readFileSync(f.live); assert.throws(() => f.operation.apply());
  assert.deepEqual(fs.readFileSync(f.live), before); assert.equal(f.restartCalls(), 0); assert.equal(fs.existsSync(f.backup), false);
});
for (const alias of ['symlink', 'hardlink', 'mode']) test(`${alias} custody failure never writes the flow`, t => {
  const f = retirementRuntime(t), file = path.join(f.stage, 'candidate.flow.json');
  if (alias === 'mode') fs.chmodSync(file, 0o644);
  else { const saved = path.join(f.root, 'fixture-alias'); fs.renameSync(file, saved); if (alias === 'symlink') fs.symlinkSync(saved, file); else fs.linkSync(saved, file); }
  assert.throws(() => f.operation.apply()); assert.deepEqual(fs.readFileSync(f.live), f.sourceBytes); assert.equal(f.restartCalls(), 0);
});
test('a competing lease blocks before backups and is never deleted', t => {
  const f = retirementRuntime(t); f.write(f.lease, { fixtureForeign: true }); const before = fs.readFileSync(f.lease);
  assert.throws(() => f.operation.apply(), /ACTIVE_LEASE/); assert.deepEqual(fs.readFileSync(f.lease), before); assert.equal(fs.existsSync(f.backup), false);
});
for (const point of ['LEASED', 'PUBLISH_INTENT', 'PUBLISHED_BYTES']) test(`crash at ${point}: forward recovery never restores or restarts source`, t => {
  const f = retirementRuntime(t); let once = true;
  f.hook(phase => { if (phase === point && once) { once = false; throw Error('FIXTURE_CRASH'); } });
  assert.throws(() => f.operation.apply(), /FIXTURE_CRASH/); assert.equal(f.restartCalls(), 0);
  const r = f.operation.recover(); assert.equal(r.phase, 'SOAKING'); assert.deepEqual(fs.readFileSync(f.live), f.candidateBytes);
  assert.equal(f.restartCalls(), 1); assert.throws(() => f.operation.abortBeforePublication(), /ABORT_FORBIDDEN/);
});
for (const point of ['LEASED', 'PUBLISH_INTENT']) test(`expiry after ${point} can only abort; no delayed first publication`, t => {
  const f = retirementRuntime(t); f.hook(phase => { if (phase === point) f.advance(31 * 60 * 1000); });
  assert.throws(() => f.operation.apply(), /EXPIRED_ABORT_UNPUBLISHED/);
  assert.throws(() => f.operation.recover(), /EXPIRED_ABORT_UNPUBLISHED/);
  assert.equal(f.operation.abortBeforePublication().phase, 'ABORTED'); assert.equal(f.restartCalls(), 0);
  assert.deepEqual(fs.readFileSync(f.live), f.sourceBytes); assert.equal(fs.existsSync(f.lease), false);
});
test('expiry during backup preparation leaves a valid journal and an abortable unpublished lease', t => {
  const f = retirementRuntime(t);
  f.hook(phase => { if (phase === 'FIXTURE_BACKUPS_READY') f.advance(31 * 60 * 1000); });
  assert.throws(() => f.operation.apply(), /EXPIRED_ABORT_UNPUBLISHED/);
  assert.equal(f.read(path.join(f.op, 'journal.json')).createdAtMs, f.contract.preparedAtMs);
  assert.equal(f.operation.status().diskState, 'SOURCE');
  assert.throws(() => f.operation.recover(), /EXPIRED_ABORT_UNPUBLISHED/);
  assert.equal(f.operation.abortBeforePublication().phase, 'ABORTED');
  assert.equal(f.restartCalls(), 0); assert.equal(fs.existsSync(f.lease), false);
  assert.deepEqual(fs.readFileSync(f.live), f.sourceBytes);
});
test('restart intent exists before command, uncertain result is held without retry or source restore', t => {
  const f = retirementRuntime(t); f.setRestartMode('throw-before');
  assert.throws(() => f.operation.apply(), /ACK_UNKNOWN/); assert.equal(f.read(path.join(f.op, 'journal.json')).phase, 'RESTART_INTENT');
  for (let i = 0; i < 2; i++) assert.throws(() => f.operation.recover(), /OUTCOME_UNKNOWN_OWNER_DECISION/);
  assert.equal(f.restartCalls(), 1); assert.deepEqual(fs.readFileSync(f.live), f.candidateBytes); assert.equal(fs.existsSync(f.lease), true);
});
test('lost restart acknowledgement is reconciled by exact process transition, never a second restart', t => {
  const f = retirementRuntime(t); f.setRestartMode('throw-after'); assert.throws(() => f.operation.apply(), /ACK_LOST/);
  assert.equal(f.operation.recover().phase, 'SOAKING'); assert.equal(f.operation.recover().restartReplayed, false);
  assert.equal(f.restartCalls(), 1); assert.deepEqual(fs.readFileSync(f.live), f.candidateBytes);
});
for (const failure of ['offline', 'extra-restart']) test(`${failure} runtime stays held for owner decision`, t => {
  const f = retirementRuntime(t); f.setRestartMode(failure); assert.throws(() => f.operation.apply()); assert.throws(() => f.operation.recover());
  assert.equal(f.restartCalls(), 1); assert.equal(fs.existsSync(f.lease), true); assert.deepEqual(fs.readFileSync(f.live), f.candidateBytes);
});
test('foreign write during restart or before publication is never overwritten by recovery', t => {
  const f = retirementRuntime(t); f.hook(phase => { if (phase === 'PUBLISH_INTENT') f.write(f.live, [{ id: 'fixture-foreign', type: 'debug' }]); });
  assert.throws(() => f.operation.apply(), /FOREIGN_FLOW/); const before = fs.readFileSync(f.live);
  assert.throws(() => f.operation.recover(), /FOREIGN_FLOW/); assert.throws(() => f.operation.abortBeforePublication());
  assert.deepEqual(fs.readFileSync(f.live), before); assert.equal(f.restartCalls(), 0); assert.equal(fs.existsSync(f.lease), true);
});
test('pre-publication abort is durable/idempotent and performs no restore or restart', t => {
  const f = retirementRuntime(t); f.hook(phase => { if (phase === 'LEASED') throw Error('FIXTURE_STOP'); });
  assert.throws(() => f.operation.apply(), /FIXTURE_STOP/); f.hook(() => {});
  assert.equal(f.operation.abortBeforePublication().phase, 'ABORTED'); assert.equal(f.operation.abortBeforePublication().phase, 'ABORTED');
  assert.equal(f.restartCalls(), 0); assert.equal(fs.existsSync(f.lease), false); assert.deepEqual(fs.readFileSync(f.live), f.sourceBytes);
});
for (const fault of ['early', 'stale', 'not-ready', 'wrong-flow', 'wrong-pid', 'wrong-contract']) test(`finish refuses ${fault} observation and retains custody`, t => {
  const f = retirementRuntime(t); f.operation.apply(); if (fault !== 'early') f.advance(SOAK);
  const overrides = fault === 'stale' ? { observedAtMs: f.now() - 31000 } : fault === 'not-ready' ? { readiness: 'unknown' }
    : fault === 'wrong-flow' ? { runtimeFlow: f.flow } : fault === 'wrong-pid' ? { pid: 9999 }
      : fault === 'wrong-contract' ? { contractSha256: '0'.repeat(64) } : {};
  f.observe(overrides); assert.throws(() => f.operation.finish()); assert.equal(fs.existsSync(f.lease), true); assert.equal(f.restartCalls(), 1);
});
test('finish needs positive runtime graph/readiness proof after soak, then releases idempotently', t => {
  const f = retirementRuntime(t); f.operation.apply(); f.advance(SOAK); f.observe();
  const r = f.operation.finish(); assert.equal(r.phase, 'COMPLETE'); assert.equal(r.leaseReleased, true);
  assert.equal(f.operation.finish().resumed, true); assert.equal(fs.existsSync(f.lease), false); assert.equal(f.restartCalls(), 1);
  f.observe({ readiness: 'unknown' }); assert.throws(() => f.operation.finish(), /COMPLETION_RECEIPT_DRIFT/);
});
test('crash after completion receipt resumes lease release without another restart', t => {
  const f = retirementRuntime(t); f.operation.apply(); f.advance(SOAK); f.observe(); let once = true;
  f.hook(phase => { if (phase === 'COMPLETE' && once) { once = false; throw Error('FIXTURE_CRASH'); } });
  assert.throws(() => f.operation.finish(), /FIXTURE_CRASH/); assert.equal(fs.existsSync(f.lease), true);
  assert.equal(f.operation.finish().leaseReleased, true); assert.equal(f.restartCalls(), 1); assert.equal(fs.existsSync(f.lease), false);
});
test('foreign graph after completion intent prevents lease unlink', t => {
  const f = retirementRuntime(t); f.operation.apply(); f.advance(SOAK); f.observe();
  f.hook(phase => { if (phase === 'COMPLETE') f.write(f.live, [{ id: 'fixture-foreign', type: 'debug' }]); });
  assert.throws(() => f.operation.finish(), /FOREIGN_FLOW/); assert.equal(fs.existsSync(f.lease), true);
});
for (const phase of ['applying', 'soaking', 'rollback-restart-required']) test(`generic paths cannot expire/restore a retirement ${phase} lease`, t => {
  const f = retirementRuntime(t); f.operation.apply(); const old = f.read(f.lease); f.write(f.lease, { ...old, phase, expiresAtMs: f.now() - 1, acquiredAtMs: f.now() - SOAK });
  const beforeLease = fs.readFileSync(f.lease), beforeFlow = fs.readFileSync(f.live), options = ordinaryBackups(f), generic = ordinary(f);
  assert.throws(() => generic.preflight({})); assert.throws(() => generic.apply({ stamp: '20261112T180000+0300' }));
  assert.throws(() => generic.rollback(options));
  assert.deepEqual(fs.readFileSync(f.lease), beforeLease); assert.deepEqual(fs.readFileSync(f.live), beforeFlow); assert.equal(f.restartCalls(), 1);
});
test('generic rollback refuses the retirement backup contract even without lease', t => {
  const f = retirementRuntime(t); const options = ordinaryBackups(f); f.write(f.live, f.candidateBytes);
  assert.throws(() => ordinary(f).rollback(options), /source restore.*forbidden/);
  assert.deepEqual(fs.readFileSync(f.live), f.candidateBytes); assert.equal(f.restartCalls(), 0);
});
test('generic rollback refuses active retirement lease even if backup contract has been relabelled', t => {
  const f = retirementRuntime(t); f.operation.apply(); const options = ordinaryBackups(f, { ...f.contract, contractKind: 'fixture-other', rollbackPolicy: 'restore-source' });
  assert.throws(() => ordinary(f).rollback(options), /source restore.*forbidden/); assert.equal(f.restartCalls(), 1); assert.equal(fs.existsSync(f.lease), true);
});
test('ordinary rollback cannot relabel a removal artifact as a supported old schema', t => {
  const f = retirementRuntime(t);
  const forged = { ...f.contract, formatVersion: 2, contractKind: 'exact-graph', rollbackPolicy: undefined,
    allowedChanges: [{ id: 'fixture-counter_builder', fields: ['func'] }], allowedAdditions: [] };
  const options = ordinaryBackups(f, forged), stamp = '20261112T180000+0300';
  f.write(path.join(f.backup, `candidate-${f.contract.deploymentId}-${stamp}.flow.json`), f.candidateBytes); f.write(f.live, f.candidateBytes);
  assert.throws(() => ordinary(f).rollback(options), /removed live node/);
  assert.deepEqual(fs.readFileSync(f.live), f.candidateBytes); assert.equal(f.restartCalls(), 0);
});
test('matching lease hardlink crash residue is repaired only during explicit owned recovery', t => {
  const f = retirementRuntime(t); f.operation.apply();
  // The durable helper recognizes exactly its own publication temporary naming scheme.
  const temporary = path.join(f.root, `.${path.basename(f.lease)}.fixture.fixture.tmp`);
  fs.linkSync(f.lease, temporary); assert.equal(fs.statSync(f.lease).nlink, 2);
  assert.equal(f.operation.status().readOnly, true); assert.equal(fs.statSync(f.lease).nlink, 2);
  assert.equal(f.operation.recover().phase, 'SOAKING'); assert.equal(fs.statSync(f.lease).nlink, 1);
  assert.equal(fs.existsSync(temporary), false); assert.equal(f.restartCalls(), 1);
});
test('foreign hardlinked lease is never repaired or removed', t => {
  const f = retirementRuntime(t); f.operation.apply(); const lease = f.read(f.lease); f.write(f.lease, { ...lease, token: 'fixture-foreign-token' });
  const temporary = path.join(f.root, `.${path.basename(f.lease)}.fixture.fixture.tmp`); fs.linkSync(f.lease, temporary);
  const before = fs.readFileSync(f.lease); assert.throws(() => f.operation.recover(), /FOREIGN_LEASE/);
  assert.deepEqual(fs.readFileSync(f.lease), before); assert.equal(fs.statSync(f.lease).nlink, 2); assert.equal(fs.existsSync(temporary), true);
});
test('backup and journal tampering or lease ownership drift stop recovery', t => {
  const f = retirementRuntime(t); f.operation.apply(); f.write(path.join(f.op, 'candidate.flow.json'), []);
  assert.throws(() => f.operation.recover(), /BACKUP_DRIFT/); assert.equal(f.restartCalls(), 1); assert.equal(fs.existsSync(f.lease), true);
});
test('COMPLETE resume with a retained lease requires a fresh postcheck before release', t => {
  const f = retirementRuntime(t); f.operation.apply(); f.advance(SOAK); f.observe(); let once = true;
  f.hook(phase => { if (phase === 'COMPLETE' && once) { once = false; throw Error('FIXTURE_CRASH'); } });
  assert.throws(() => f.operation.finish(), /FIXTURE_CRASH/); f.advance(31000);
  assert.throws(() => f.operation.finish(), /POSTCHECK_UNVERIFIED/); assert.equal(fs.existsSync(f.lease), true);
  f.observe(); assert.equal(f.operation.finish().leaseReleased, true); assert.equal(f.restartCalls(), 1);
});
test('slow durable completion cannot release custody after the postcheck freshness window', t => {
  const f = retirementRuntime(t); f.operation.apply(); f.advance(SOAK); f.observe(); let once = true;
  f.hook(phase => { if (phase === 'COMPLETE' && once) { once = false; f.advance(31000); } });
  assert.throws(() => f.operation.finish(), /POSTCHECK_UNVERIFIED/); assert.equal(fs.existsSync(f.lease), true);
  f.observe(); assert.equal(f.operation.finish().leaseReleased, true);
});
test('SOURCE appearing after SOAKING is never treated as healthy forward recovery', t => {
  const f = retirementRuntime(t); f.operation.apply(); f.write(f.live, f.sourceBytes);
  assert.throws(() => f.operation.recover(), /SOURCE_RETURNED_OWNER_DECISION/);
  assert.deepEqual(fs.readFileSync(f.live), f.sourceBytes); assert.equal(f.restartCalls(), 1); assert.equal(fs.existsSync(f.lease), true);
});
test('CLI requires explicit staged root target, exact arguments and mutation authorization', () => {
  const stage = '/root/.node-red/.padlhub-reviewed-flow-stage-20261112T180000+0300-123';
  const self = `${stage}/scripts/nodered_reviewed_flow_deploy/legacy_retirement_operation.mjs`, digest = 'a'.repeat(64);
  assert.equal(validateLegacyRetirementCli(['status', stage, digest], { uid: 0, self }).action, 'status');
  assert.equal(validateLegacyRetirementCli(['apply', stage, digest, 'RETIRE_14_LEGACY_NODES_147_FORWARD_ONLY'], { uid: 0, self }).action, 'apply');
  for (const args of [['rollback', stage, digest], ['apply', stage, digest], ['apply', stage, digest, 'fixture-wrong'],
    ['status', stage, digest, 'fixture-extra'], ['status', '/tmp/fixture-stage', digest], ['status', stage, 'fixture-bad-hash']]) {
    assert.throws(() => validateLegacyRetirementCli(args, { uid: 0, self }));
  }
  assert.throws(() => validateLegacyRetirementCli(['status', stage, digest], { uid: 501, self }));
  assert.throws(() => validateLegacyRetirementCli(['status', stage, digest], { uid: 0, self: '/tmp/fixture-runner.mjs' }));
});
