import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { buildExactGraphContract, validateExactGraphContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';
import { assertPiterAtomicTopology, assertNoEnabledLegacyPiterSalesTab } from './lib/piterAtomicTopologyContract.mjs';
import { buildHubRuntimeEvidence } from './lib/hubLk1SaleContract.mjs';
import { salesConfigurationInitializer } from './lib/subscriptionSalesConfiguration.mjs';
import { syncAnnualHistory } from './sync_annual_subscription_history.mjs';

const hash = x => createHash('sha256').update(x).digest('hex');
export function buildAnnualHistoryCandidate({ liveBytes, sourceTexts, binding }) {
  if (binding.kind !== 'ANNUAL_HISTORY_CANDIDATE_BINDING_V1' || hash(liveBytes) !== binding.sourceSha256) throw Error('annual candidate preimage drift');
  const source = JSON.parse(liveBytes), candidate = structuredClone(source);
  if (source.length !== binding.sourceNodeCount || source.filter(n => n.type === 'http in').length !== binding.httpInputCount) throw Error('annual candidate graph scope drift');
  const evidence = buildHubRuntimeEvidence(source);
  if (JSON.stringify(evidence) !== JSON.stringify(binding.hubEvidence)) throw Error('HAB preserved policy provenance drift');
  const changes = [];
  for (const target of binding.targets) {
    const matches = candidate.filter(n => n.id === target.id), node = matches[0], code = sourceTexts[target.file];
    if (matches.length !== 1 || hash(JSON.stringify(node)) !== target.preimageNodeSha256
      || node.type !== 'function' || typeof code !== 'string' || hash(code) !== target.sourceTextSha256) throw Error('annual candidate target drift');
    new vm.Script(`(function(msg,node,context,flow,global,env){${code}\n})`);
    node.func = code; const fields = ['func'];
    if (node.id === 'piter_atomic_router_20260903') { node.initialize += salesConfigurationInitializer(); fields.push('initialize'); }
    changes.push({ id: node.id, fields });
  }
  const db = candidate.find(n => n.id === 'ab1e202650000003');
  if (!db || hash(JSON.stringify(db)) !== binding.reconcileFindPreimageSha256
    || JSON.stringify(db.wires) !== JSON.stringify([['ab1e202650000004']])) throw Error('annual reconcile graph drift');
  db.wires = [[binding.expander.id]]; changes.push({ id: db.id, fields: ['wires'] });
  const expandSource = sourceTexts[binding.expander.file];
  if (hash(expandSource) !== binding.expander.sourceTextSha256 || candidate.some(n => n.id === binding.expander.id)) throw Error('annual expander source drift');
  new vm.Script(`(function(msg,node,context,flow,global,env){${expandSource}\n})`);
  candidate.push({ id: binding.expander.id, type: 'function', z: db.z, name: 'Expand annual history reconciliation watches',
    func: expandSource, outputs: 1, timeout: 0, noerr: 0, initialize: '', finalize: '', libs: [],
    x: db.x + 80, y: db.y + 40, wires: [['ab1e202650000004']] });
  assertPiterAtomicTopology(candidate, { atomicInitializer: candidate.find(n => n.id === 'piter_atomic_router_20260903').initialize,
    atomicRouterSha256: binding.targets.find(t => t.id === 'piter_atomic_router_20260903').sourceTextSha256 });
  assertNoEnabledLegacyPiterSalesTab(candidate);
  const candidateBytes = Buffer.from(JSON.stringify(candidate, null, 2) + '\n');
  if (hash(candidateBytes) !== binding.candidateSha256) throw Error('annual final candidate digest drift');
  const args = { liveBytes, candidateBytes, deploymentId: 'annual-history-opening-20260909', allowedChanges: changes,
    allowedAdditionIds: [binding.expander.id] };
  const contract = buildExactGraphContract(args); validateExactGraphContract({ ...args, contract });
  return { candidateBytes, contract, report: { kind: binding.kind, sourceSha256: binding.sourceSha256,
    candidateSha256: binding.candidateSha256, sourceNodeCount: source.length, candidateNodeCount: candidate.length,
    httpInputCount: binding.httpInputCount, changedNodeIds: changes.map(c => c.id), addedNodeIds: [binding.expander.id],
    deploymentPerformed: false, activationPerformed: false } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [sourcePath, outputDir] = process.argv.slice(2);
    if (!path.isAbsolute(sourcePath || '') || !path.isAbsolute(outputDir || '') || process.argv.length !== 4) throw Error('Usage: /absolute/fresh-flow /absolute/new-private-output');
    const sourceStat = fs.lstatSync(sourcePath);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || (sourceStat.mode & 0o077)) throw Error('private regular source required');
    syncAnnualHistory({ check: true });
    const binding = JSON.parse(fs.readFileSync(new URL('./annual_subscription_history_binding.json', import.meta.url)));
    const files = [...binding.targets.map(t => t.file), binding.expander.file];
    const sourceTexts = Object.fromEntries(files.map(f => [f, fs.readFileSync(new URL(`./nodered_games_nodes/${f}`, import.meta.url), 'utf8')]));
    const result = buildAnnualHistoryCandidate({ liveBytes: fs.readFileSync(sourcePath), sourceTexts, binding });
    fs.mkdirSync(outputDir, { mode: 0o700 });
    for (const [name, contents] of Object.entries({ 'candidate.flow.json': result.candidateBytes,
      'reviewed-flow.contract.json': JSON.stringify(result.contract, null, 2) + '\n', 'report.json': JSON.stringify(result.report, null, 2) + '\n' })) {
      fs.writeFileSync(path.join(outputDir, name), contents, { mode: 0o600, flag: 'wx' });
    }
    console.log(JSON.stringify(result.report));
  } catch { console.error('Annual history candidate failed; no deployment or activation performed.'); process.exitCode = 1; }
}
