import { isDeepStrictEqual } from 'node:util';
import { TRANSPORT_CASES, NATIVE_CANCEL_TRANSPORT_CASES, BOOKING_HTTP_CONSUMER_SHA256 } from './bookingTransportLiveContract.mjs';
import { UNPAID_SOURCE_FILES } from './unpaidWorkerSourceFiles.mjs';
import { BOOKING_TRANSPORT_CATCH_ID, BOOKING_TRANSPORT_RECOVERY_ID, prepareBookingTransportRecovery,
  bookingTransportRecoveryNodes, sha256 } from './subscriptionBookingTransportRecovery.mjs';

const hash = value => /^[a-f0-9]{64}$/.test(value || '');
const commit = value => /^[a-f0-9]{40}$/.test(value || '');
export const WORKER_GUARD = 'lib/lk1LiveGatewayGuard.mjs';
const pin = (source, name) => {
  const matches = [...source.matchAll(new RegExp(`export const ${name} = '([a-f0-9]{64})';`, 'g'))];
  if (matches.length !== 1) throw new Error('WORKER_PIN_DRIFT');
  return matches[0][1];
};

export function validateLiveProof(proof, now = Date.now()) {
  const age = now - Date.parse(proof?.observedUtc);
  if (proof?.schema !== 1 || !Number.isFinite(age) || age < 0 || age > 1800000
    || ![proof.sourceSha256, proof.candidateSha256, proof.routerSha256, proof.worker?.baseManifestSha256,
      proof.worker?.unitSha256, proof.worker?.environmentSha256].every(hash)
    || proof.sourceSha256 === proof.candidateSha256
    || proof.httpConsumerSha256 !== BOOKING_HTTP_CONSUMER_SHA256 || proof.transportGap !== 'SENDERR_TRUE_WITHOUT_HTTP_CATCH'
    || proof.activeFlowMatchesDisk !== true || proof.processStable !== true || proof.bindingMatchesWorker !== true
    || proof.unchangedExistingNodes !== true || proof.productionWrites !== 0 || proof.businessRequests !== 0
    || proof.privateSourceExported !== false || proof.worker.serviceActive !== true || proof.worker.otherWorkerPresent !== false) {
    throw new Error('LIVE_PROOF_INVALID_OR_STALE');
  }
  if (!Number.isSafeInteger(proof.worker.identity?.pid) || proof.worker.identity.pid <= 0
    || proof.worker.identity.effectiveConfigurationMatches !== true || proof.worker.identity.dropIns !== 0
    || proof.worker.identity.unitSha256 !== proof.worker.unitSha256
    || proof.worker.identity.environmentSha256 !== proof.worker.environmentSha256
    || proof.worker.identity.manifestSha256 !== proof.worker.baseManifestSha256
    || proof.worker.identity.releasePath !== proof.worker.releasePath
    || !Array.isArray(proof.worker.retainedAuthModuleRefs)
    || !proof.worker.retainedAuthModuleRefs.length
    || proof.worker.retainedAuthModuleRefs.some(ref => !/^\/opt\/padlhub-lk1-unpaid-cancel\/releases\/[a-f0-9]{40}\/lib\/lk1FlowReadTokenAuth\.cjs$/.test(ref.modulePath)
      || !hash(ref.sha256))) throw new Error('RUNNING_WORKER_PROOF_INVALID');
  const expectedCases = TRANSPORT_CASES.map(([step, caller, status]) => ({ step, caller, status,
    branchReached: true, httpDispatches: 0, persistenceDispatches: 0, asynchronousSends: 0 }));
  if (!isDeepStrictEqual(proof.ownerCases, expectedCases)) throw new Error('OWNER_PROOF_INCOMPLETE');
  const expectedNative = NATIVE_CANCEL_TRANSPORT_CASES.map(([nativeStage, durablyAccepted, status]) => ({
    step: 'lk1_free_cancel_effect', caller: 'http', status, branchReached: true,
    httpDispatches: 0, persistenceDispatches: 0, asynchronousSends: 0,
    nativeStage, durablyAccepted, protocolStatePreserved: true,
  }));
  if (!isDeepStrictEqual(proof.nativeCancellationCases, expectedNative)) throw new Error('NATIVE_CANCEL_PROOF_INCOMPLETE');
  for (const [version, policy] of [['1', 'ATOMIC_MANAGED_V1'], ['2', 'MANAGED_JOIN_V2']]) {
    const actual = proof.probes?.filter(p => p.version === version);
    if (actual?.length !== 1 || !isDeepStrictEqual(actual[0], { version, status: 200, supported: true, policy })) throw new Error('CAPABILITY_PROOF_INCOMPLETE');
  }
  for (const [version, policy, code] of [['3', 'MANAGED_SELF_LEAVE_V1', 'BOOKED_OPERATION_OWNER_PROBE_NOT_FOUND'],
    ['training', 'TRAINING_LEGACY_V1', 'TRAINING_REGISTRATION_OWNER_UNAVAILABLE']]) {
    const actual = proof.probes?.filter(p => p.version === version);
    if (actual?.length !== 1 || !(isDeepStrictEqual(actual[0], { version, status: 200, supported: true, policy })
      || isDeepStrictEqual(actual[0], { version, status: 404, supported: false, code }))) throw new Error('CAPABILITY_PROOF_INCOMPLETE');
  }
  const c = proof.exactGraphContract;
  if (c?.sourceSha256 !== proof.sourceSha256 || c.candidateSha256 !== proof.candidateSha256
    || c.sourceNodeCount !== proof.sourceNodeCount || c.candidateNodeCount !== proof.candidateNodeCount
    || c.allowedChanges?.length !== 0 || c.allowedAdditions?.length !== 2
    || proof.candidateNodeCount !== proof.sourceNodeCount + 2
    || !isDeepStrictEqual(c.allowedAdditions.map(a => a.id).sort(), [BOOKING_TRANSPORT_CATCH_ID, BOOKING_TRANSPORT_RECOVERY_ID].sort())) throw new Error('GRAPH_PROOF_INVALID');
  if (!Array.isArray(proof.additions) || proof.additions.length !== 2 || typeof proof.additions[0].z !== 'string'
    || !isDeepStrictEqual(proof.additions, bookingTransportRecoveryNodes(proof.additions[0].z))
    || proof.additions.some(n => c.allowedAdditions.find(a => a.id === n.id)?.candidateNodeSha256 !== sha256(JSON.stringify(n)))) throw new Error('DELTA_PROOF_INVALID');
  const base = proof.worker.baseManifest;
  if (base?.schema !== 1 || !commit(base.sourceCommit)
    || !isDeepStrictEqual(Object.keys(base.files || {}).sort(), Object.keys(UNPAID_SOURCE_FILES).sort())
    || Object.values(base.files).some(v => !hash(v))
    || sha256(JSON.stringify(base, null, 2) + '\n') !== proof.worker.baseManifestSha256
    || base.files['lk1-unpaid-cancel.service'] !== proof.worker.unitSha256) throw new Error('WORKER_PROOF_INVALID');
  return proof;
}

// Deterministic generation: only the whole-flow literal in the copied guard
// changes. The historical guard source, runner, lockfile, auth module, unit,
// cohort, mode and durable cursors are never edited.
export function deriveWorkerGeneration(proof, files, builderCommit, now = Date.now()) {
  validateLiveProof(proof, now);
  if (!commit(builderCommit) || !isDeepStrictEqual(Object.keys(files).sort(), Object.keys(UNPAID_SOURCE_FILES).sort())
    || Object.entries(files).some(([name, bytes]) => !Buffer.isBuffer(bytes) || sha256(bytes) !== proof.worker.baseManifest.files[name])) throw new Error('WORKER_SOURCE_MISMATCH');
  const before = files[WORKER_GUARD].toString();
  const oldFlow = pin(before, 'LK1_UNPAID_FLOW_SHA256'), gateway = pin(before, 'LK1_UNPAID_GATEWAY_SHA256');
  if (oldFlow !== proof.sourceSha256 || gateway !== proof.routerSha256) throw new Error('WORKER_PIN_MISMATCH');
  const after = before.replace(`export const LK1_UNPAID_FLOW_SHA256 = '${oldFlow}';`,
    `export const LK1_UNPAID_FLOW_SHA256 = '${proof.candidateSha256}';`);
  const next = { ...files, [WORKER_GUARD]: Buffer.from(after) };
  const manifest = { schema: 1, sourceCommit: builderCommit,
    files: Object.fromEntries(Object.entries(next).map(([name, bytes]) => [name, sha256(bytes)])) };
  return { files: next, manifest, derivation: { schema: 1, builderCommit,
    baseSourceCommit: proof.worker.baseManifest.sourceCommit, baseManifestSha256: proof.worker.baseManifestSha256,
    generatedManifestSha256: sha256(JSON.stringify(manifest, null, 2) + '\n'),
    sourceFlowSha256: oldFlow, candidateFlowSha256: proof.candidateSha256, gatewaySha256: gateway,
    changedFiles: [{ name: WORKER_GUARD, before: sha256(files[WORKER_GUARD]), after: sha256(next[WORKER_GUARD]) }],
    preservedFiles: Object.keys(files).filter(name => name !== WORKER_GUARD) } };
}

// Future authorized application can materialize the exact full candidate on the
// trusted host without disclosing production function bodies to the workstation.
export function materializeFromProof(sourceBytes, proof) {
  validateLiveProof(proof);
  const actual = prepareBookingTransportRecovery(sourceBytes, { sourceSha256: proof.sourceSha256, routerSha256: proof.routerSha256 });
  if (actual.candidateSha256 !== proof.candidateSha256
    || !isDeepStrictEqual(JSON.parse(actual.candidate).slice(-2), proof.additions)) throw new Error('CANDIDATE_MATERIALIZATION_DRIFT');
  return actual.candidate;
}
