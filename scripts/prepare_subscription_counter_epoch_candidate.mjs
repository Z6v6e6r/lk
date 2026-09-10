import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { buildExactGraphContract, validateExactGraphContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';
import { assertPiterAtomicTopology, assertNoEnabledLegacyPiterSalesTab } from './lib/piterAtomicTopologyContract.mjs';
import { buildHubRuntimeEvidence, normalizeFrozenHubSale } from './lib/hubLk1SaleContract.mjs';
import { salesConfigurationInitializer } from './lib/subscriptionSalesConfiguration.mjs';
import { syncAnnualHistory } from './sync_annual_subscription_history.mjs';
import { syncCounterEpoch } from './sync_subscription_counter_epoch.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
export const counterEpochTargets = Object.entries({
  status_prepare: '8fdc7076a0c436a2', status_response: 'c165e43eba668c25',
  purchase_prepare: '91dded2dc8cfebe4', purchase_limit: 'f8679e53edadc39b', purchase_router: '566ae4b886c37ae5',
  confirm_prepare: '1da9af2cb4f7db52', confirm_resolve: 'ca022fd14027a5b0',
  counter_refresh_prepare: '519b6a6ca208e281', counter_refresh_response: 'd4901c31b37eab6b',
  reconcile_query: 'ab1e202650000002', piter_atomic_router: 'piter_atomic_router_20260903',
}).map(([name, id]) => ({ id, file: `fn_tournament_subscription_${name}.js` }));

export function buildCounterEpochInitializer(initializer, receipt) {
  const configPattern = /\n\/\/ BEGIN subscription sales persistent configuration\n[\s\S]*?\/\/ END subscription sales persistent configuration\n/g;
  const receiptPattern = /^const hubSaleRuntimeReceipt = (\{[^\n]+\});$/gm;
  const configs = [...initializer.matchAll(configPattern)], receipts = [...initializer.matchAll(receiptPattern)];
  if (configs.length !== 1 || receipts.length !== 1 || !normalizeFrozenHubSale(JSON.parse(receipts[0][1]))
    || !isDeepStrictEqual(normalizeFrozenHubSale(receipt), receipt)) throw Error('epoch initializer preimage invalid');
  const code = initializer.replace(configPattern, () => salesConfigurationInitializer())
    .replace(receiptPattern, () => `const hubSaleRuntimeReceipt = ${JSON.stringify(receipt)};`);
  new vm.Script(`(function(global,env){${code}\n})`);
  return code;
}

function compose({ liveBytes, sourceTexts }) {
  const source = JSON.parse(liveBytes), candidate = structuredClone(source), changes = [];
  if (!Array.isArray(source) || new Set(source.map(n => n.id)).size !== source.length) throw Error('epoch graph invalid');
  const hubEvidence = buildHubRuntimeEvidence(source);
  for (const target of counterEpochTargets) {
    const matches = candidate.filter(n => n.id === target.id), node = matches[0], code = sourceTexts[target.file];
    if (matches.length !== 1 || node.type !== 'function' || typeof code !== 'string') throw Error('epoch target invalid');
    new vm.Script(`(function(msg,node,context,flow,global,env){${code}\n})`);
    node.func = code; const fields = ['func'];
    if (target.id === 'piter_atomic_router_20260903') {
      node.initialize = buildCounterEpochInitializer(node.initialize, hubEvidence.receipt); fields.push('initialize');
    }
    changes.push({ id: node.id, fields });
  }
  const atomic = candidate.find(n => n.id === 'piter_atomic_router_20260903');
  assertPiterAtomicTopology(candidate, { atomicInitializer: atomic.initialize, atomicRouterSha256: hash(atomic.func) });
  assertNoEnabledLegacyPiterSalesTab(candidate);
  const candidateBytes = Buffer.from(JSON.stringify(candidate, null, 2) + '\n');
  return { source, candidate, candidateBytes, changes, hubEvidence };
}

// Produces a reviewable local binding, never deploys or enables an inventory.
export function prepareCounterEpochBinding(args) {
  const result = compose(args);
  return { kind: 'SUBSCRIPTION_COUNTER_EPOCH_CANDIDATE_BINDING_V1', sourceSha256: hash(args.liveBytes),
    candidateSha256: hash(result.candidateBytes), sourceNodeCount: result.source.length,
    httpInputCount: result.source.filter(n => n.type === 'http in').length, hubEvidence: result.hubEvidence,
    targets: counterEpochTargets.map(t => ({ ...t,
      preimageNodeSha256: hash(JSON.stringify(result.source.find(n => n.id === t.id))),
      sourceTextSha256: hash(args.sourceTexts[t.file]) })) };
}

export function buildCounterEpochCandidate({ liveBytes, sourceTexts, binding }) {
  if (binding?.kind !== 'SUBSCRIPTION_COUNTER_EPOCH_CANDIDATE_BINDING_V1'
    || hash(liveBytes) !== binding.sourceSha256) throw Error('epoch candidate preimage drift');
  const actual = prepareCounterEpochBinding({ liveBytes, sourceTexts });
  if (!isDeepStrictEqual(actual, binding)) throw Error('epoch candidate binding drift');
  const built = compose({ liveBytes, sourceTexts });
  const args = { liveBytes, candidateBytes: built.candidateBytes, deploymentId: 'subscription-counter-epoch-20260910',
    allowedChanges: built.changes, allowedAdditionIds: [] };
  const contract = buildExactGraphContract(args); validateExactGraphContract({ ...args, contract });
  const reversed = structuredClone(built.candidate);
  for (const change of built.changes) {
    const before = built.source.find(n => n.id === change.id), after = reversed.find(n => n.id === change.id);
    for (const field of change.fields) after[field] = before[field];
  }
  if (!isDeepStrictEqual(reversed, built.source)) throw Error('epoch structural reverse failed');
  return { candidateBytes: built.candidateBytes, contract, report: {
    kind: binding.kind, sourceSha256: binding.sourceSha256, candidateSha256: binding.candidateSha256,
    sourceNodeCount: built.source.length, candidateNodeCount: built.candidate.length, httpInputCount: binding.httpInputCount,
    changedNodeIds: built.changes.map(c => c.id), addedNodeIds: [], structuralReverseCheckPassed: true,
    deploymentPerformed: false, activationPerformed: false } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [sourcePath, outputDir] = process.argv.slice(2);
    if (process.argv.length !== 4 || !path.isAbsolute(sourcePath || '') || !path.isAbsolute(outputDir || '')) throw Error('absolute paths required');
    const stat = fs.lstatSync(sourcePath);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw Error('private source required');
    syncCounterEpoch({ check: true }); syncAnnualHistory({ check: true });
    const binding = JSON.parse(fs.readFileSync(new URL('./subscription_counter_epoch_binding.json', import.meta.url)));
    const sourceTexts = Object.fromEntries(counterEpochTargets.map(t => [t.file, fs.readFileSync(new URL(`./nodered_games_nodes/${t.file}`, import.meta.url), 'utf8')]));
    const result = buildCounterEpochCandidate({ liveBytes: fs.readFileSync(sourcePath), sourceTexts, binding });
    fs.mkdirSync(outputDir, { mode: 0o700 });
    for (const [name, data] of Object.entries({ 'candidate.flow.json': result.candidateBytes,
      'reviewed-flow.contract.json': JSON.stringify(result.contract, null, 2) + '\n',
      'report.json': JSON.stringify(result.report, null, 2) + '\n' })) {
      fs.writeFileSync(path.join(outputDir, name), data, { mode: 0o600, flag: 'wx' });
    }
    console.log(JSON.stringify(result.report));
  } catch { console.error('Counter epoch preparation failed; no deploy or activation performed.'); process.exitCode = 1; }
}
