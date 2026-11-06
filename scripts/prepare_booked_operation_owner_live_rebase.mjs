import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { LIVE_REBASE_SOURCE_SHA256, LIVE_REBASE_UNITS, LIVE_REBASE_BASE_COMMIT, hash, rebaseOwnerUnits }
  from './lib/bookedOperationOwnerLiveRebase.mjs';
import { assertFlowArray, verifyWorkspace } from './verify_nodered_source_origin.mjs';
import { assertHubOutputPath } from './patch_live_lk1_hub.mjs';
import { readRepositoryProvenance } from './lib/release-provenance.mjs';
import { buildExactGraphContract, validateReviewedFlowContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';

// Source-only. Builds a reviewed exact-graph packet; never imports, restarts or writes a server.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const id = name => 'lk_subscription_booking_' + name + '_20260804';
const CLOSURE = [
  'scripts/prepare_booked_operation_owner_live_rebase.mjs',
  'scripts/lib/bookedOperationOwnerLiveRebase.mjs',
  'scripts/lib/bookedOperationOwnerCompatibility.mjs',
  'scripts/verify_nodered_source_origin.mjs', 'scripts/lib/release-provenance.mjs',
  'scripts/nodered_reviewed_flow_deploy/runtime_contract.mjs',
  'package.json', 'package-lock.json',
  ...LIVE_REBASE_UNITS.flatMap(unit => unit[2].map(([file]) => 'scripts/nodered_subscription_booking_nodes/' + file)),
];

// Installed topology on lk-primary-147 (flows.json f6fd9f05…). Wiring never changes in this step.
export const LIVE_REBASE_TOPOLOGY = Object.freeze({
  [id('router')]: { type: 'function', outputs: 8, wires: [[id('http')], [id('find')], [id('insert')], [id('update')],
    [id('finalize')], [id('debug')], ['lk_subscription_managed_policy_20260820'], ['lk_subscription_product_router_20260907']] },
  [id('prepare')]: { type: 'function', outputs: 2, wires: [[id('http')], [id('finalize')]] },
  [id('finalize')]: { type: 'function', outputs: 2, wires: [['8f7bd5b482fe9763'], [id('response')]] },
  [id('mongo_error')]: { type: 'function', outputs: 1, wires: [[id('finalize')]] },
  [id('options')]: { type: 'function', outputs: 2, wires: [[id('options_response')], [id('router')]] },
  [id('catch')]: { type: 'catch', wires: [[id('mongo_error')]] },
  [id('post')]: { type: 'http in', method: 'post', url: '/lk/subscription-bookings', wires: [[id('prepare')]] },
  lk_subscription_booking_owner_probe_get_20261023: { type: 'http in', method: 'get', url: '/lk/subscription-bookings', wires: [[id('options')]] },
});

export function assertLiveRebaseTopology(flow) {
  const z = flow.find(node => node.id === id('router'))?.z;
  for (const [nodeId, expected] of Object.entries(LIVE_REBASE_TOPOLOGY)) {
    const node = flow.find(row => row.id === nodeId);
    if (!node || node.z !== z || Object.entries(expected).some(([key, value]) => !isDeepStrictEqual(node[key], value))) {
      throw new Error('Owner live rebase topology drift: ' + nodeId);
    }
  }
  const scope = flow.find(node => node.id === id('catch')).scope;
  if (!Array.isArray(scope) || !['find', 'insert', 'update'].every(name => scope.includes(id(name)))) {
    throw new Error('Owner live rebase persistence catch drift');
  }
}

export function composeOwnerLiveRebase(liveBytes, deploymentId) {
  if (hash(liveBytes) !== LIVE_REBASE_SOURCE_SHA256) throw new Error('Owner live rebase whole-flow preimage drift');
  const flow = JSON.parse(Buffer.from(liveBytes).toString('utf8'));
  assertFlowArray(flow);
  assertLiveRebaseTopology(flow);
  const { candidate, reports } = rebaseOwnerUnits(flow);
  assertLiveRebaseTopology(candidate);
  const router = candidate.find(node => node.id === id('router')).func;
  // Output 7 stays the single installed product continuation.
  if (router.split('emit(7)').length !== 2 || /\[(?:null, ){7,}[A-Za-z_$][\w$]*\]/.test(router)) {
    throw new Error('Owner live rebase output index drift');
  }
  const allowedChanges = LIVE_REBASE_UNITS.map(unit => ({ id: unit[1], fields: ['func'] }));
  const candidateBytes = Buffer.from(JSON.stringify(candidate, null, 2) + '\n');
  const contract = buildExactGraphContract({ liveBytes, candidateBytes, deploymentId, allowedChanges, allowedAdditionIds: [] });
  validateReviewedFlowContract({ liveBytes, candidateBytes, contract });
  return { candidate, candidateBytes, contract, reports };
}

function provenance() {
  const identity = readRepositoryProvenance(ROOT);
  if (identity.sourceDirty) throw new Error('Commit the exact owner live rebase source before packet generation');
  return { ...identity, sourceFiles: Object.fromEntries(CLOSURE.map(file => [file, hash(fs.readFileSync(path.join(ROOT, file)))])) };
}

export function prepareOwnerLiveRebase(workspace, outputDirectory) {
  const output = assertHubOutputPath(outputDirectory);
  const source = provenance();
  const verified = verifyWorkspace(workspace, { quiet: true });
  const liveBytes = fs.readFileSync(verified.sourcePath);
  if (hash(liveBytes) !== verified.sourceSha256) throw new Error('Verified owner source changed');
  const packet = composeOwnerLiveRebase(liveBytes, 'owner-live-rebase-' + source.sourceCommit.slice(0, 12));
  if (!isDeepStrictEqual(source, provenance())) throw new Error('Owner source changed during composition');
  const report = { ...source, baseCommit: LIVE_REBASE_BASE_COMMIT, sourceSha256: hash(liveBytes),
    candidateSha256: hash(packet.candidateBytes), contractSha256: hash(JSON.stringify(packet.contract, null, 2) + '\n'),
    contractKind: 'exact-graph', nodeCount: packet.candidate.length, additions: 0, wiresChanged: false,
    changed: packet.reports, sourceOnly: true, activationAuthorized: false, imported: false, providerWritesPerformed: false };
  fs.mkdirSync(output, { mode: 0o700 });
  for (const [name, value] of [['candidate.flow.json', packet.candidateBytes],
    ['contract.json', JSON.stringify(packet.contract, null, 2) + '\n'],
    ['report.json', JSON.stringify(report, null, 2) + '\n']]) {
    fs.writeFileSync(path.join(output, name), value, { mode: 0o600, flag: 'wx' });
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4) throw new Error('Usage: <fresh-private-live-workspace> <new-private-output-directory>');
    console.log(JSON.stringify(prepareOwnerLiveRebase(process.argv[2], process.argv[3]), null, 2));
  } catch (error) {
    console.error(error.message); process.exitCode = 1;
  }
}
