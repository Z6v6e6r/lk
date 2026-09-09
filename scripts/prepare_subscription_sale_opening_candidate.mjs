#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { verifyWorkspace, assertFlowArray } from './verify_nodered_source_origin.mjs';
import { sha256, buildExactGraphContract, validateExactGraphContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';
import { assertPiterAtomicTopology, assertNoEnabledLegacyPiterSalesTab, PITER_ATOMIC_BINDING_INITIALIZER_SOURCE } from './lib/piterAtomicTopologyContract.mjs';
import { buildHubRuntimeEvidence } from './lib/hubLk1SaleContract.mjs';
import { PITER_QUOTA48_UPDATE } from './lib/piterAtomicQuotaUpdateContract.mjs';
const sourceDir = new URL('./nodered_games_nodes/', import.meta.url);
const fail = message => { throw new Error('Sale opening candidate blocked: ' + message); };
// Pure fixture injection only. The CLI accepts no source/hash/target overrides.
export function buildSaleOpeningCandidate({ liveBytes, sourceTexts, expected = PITER_QUOTA48_UPDATE }) {
  if (sha256(liveBytes) !== expected.sourceSha256) fail('source drift');
  const live = JSON.parse(Buffer.from(liveBytes).toString('utf8')); assertFlowArray(live);
  if (live.length !== expected.sourceNodeCount || live.filter(n => n.type === 'http in').length !== expected.httpInputCount) fail('source counts drift');
  const hubEvidence = buildHubRuntimeEvidence(live);
  if (JSON.stringify(hubEvidence.receipt) !== JSON.stringify(expected.hubBookingReceipt)
    || JSON.stringify(hubEvidence.nodes) !== JSON.stringify(expected.preservedHubNodes)) fail('HUB receipt provenance drift');
  for (const dependency of expected.preservedHubNodes || []) {
    const matches = live.filter(n => n.id === dependency.id);
    if (matches.length !== 1 || sha256(JSON.stringify(matches[0])) !== dependency.nodeSha256) fail('HUB dependency drift');
  }
  const candidate = structuredClone(live), changes = [];
  for (const target of expected.targets) {
    const matches = candidate.filter(n => n.id === target.id); const node = matches[0];
    if (matches.length !== 1 || node.type !== 'function' || node.z !== 'f9575c8726e29196'
      || node.name !== target.name || node.outputs !== target.outputs
      || sha256(node.func) !== target.sourceSha256) fail('target preimage drift');
    const code = sourceTexts[target.file];
    if (typeof code !== 'string' || sha256(code) !== target.candidateSha256) fail('replacement drift');
    new vm.Script('(function(msg,node,context,flow,global,env){\n' + code + '\n})');
    node.func = code;
    const fields = ['func'];
    if (node.id === 'ca022fd14027a5b0') {
      if (node.outputs !== 3 || node.wires.length !== 3) fail('confirm preimage topology');
      node.outputs = 4; node.wires.push(['piter_atomic_router_20260903']); fields.push('outputs', 'wires');
    }
    if (node.id === 'piter_atomic_router_20260903') {
      if (node.initialize !== PITER_ATOMIC_BINDING_INITIALIZER_SOURCE) fail('atomic initializer preimage');
      node.initialize += expected.hubReceiptInitializer || ''; fields.push('initialize');
    }
    changes.push({ id: node.id, fields });
  }
  assertPiterAtomicTopology(candidate, { atomicInitializer: PITER_ATOMIC_BINDING_INITIALIZER_SOURCE + (expected.hubReceiptInitializer || '') }); assertNoEnabledLegacyPiterSalesTab(candidate);
  const candidateBytes = Buffer.from(JSON.stringify(candidate, null, 2) + '\n');
  if (candidate.length !== expected.candidateNodeCount || sha256(candidateBytes) !== expected.candidateSha256) fail('candidate digest drift');
  const args = { liveBytes, candidateBytes, deploymentId: expected.deploymentId, allowedChanges: changes, allowedAdditionIds: [] };
  const contract = buildExactGraphContract(args); validateExactGraphContract({ ...args, contract });
  const reverse = buildExactGraphContract({ ...args, liveBytes: candidateBytes, candidateBytes: liveBytes });
  validateExactGraphContract({ liveBytes: candidateBytes, candidateBytes: liveBytes, contract: reverse });
  const report = { ok: true, deploymentId: expected.deploymentId, updateKind: expected.updateKind,
    sourceSha256: expected.sourceSha256, candidateSha256: expected.candidateSha256,
    sourceNodeCount: live.length, candidateNodeCount: candidate.length, httpInputCount: expected.httpInputCount,
    launchQuotaSchemaVersion: 2, changedNodeIds: changes.map(x => x.id), addedNodeCount: 0,
    structuralReverseCheckPassed: true, rollbackRequiresDataPrecheck: true, ledgerActivationRequired: true,
    deploymentPerformed: false, activationPerformed: false };
  return { candidateBytes, contract, reverse, report };
}
export function prepareSaleOpeningCandidate(argv) {
  if (argv.length !== 2 || argv[0] !== '--workspace') fail('Usage: --workspace /absolute/fresh-private-workspace');
  const verified = verifyWorkspace(argv[1], { quiet: true });
  const liveBytes = fs.readFileSync(verified.sourcePath);
  if (sha256(liveBytes) !== verified.sourceSha256) fail('source custody drift');
  const sourceTexts = Object.fromEntries(PITER_QUOTA48_UPDATE.targets.map(t => [t.file, fs.readFileSync(new URL(t.file, sourceDir), 'utf8')]));
  const built = buildSaleOpeningCandidate({ liveBytes, sourceTexts });
  const out = path.join(verified.workspace, 'build-sale-opening'); fs.mkdirSync(out, { mode: 0o700 });
  for (const [name, value] of Object.entries({ 'candidate.flow.json': built.candidateBytes,
    'reviewed-flow.contract.json': JSON.stringify(built.contract, null, 2) + '\n',
    'structural-reverse.contract.json': JSON.stringify(built.reverse, null, 2) + '\n',
    'report.json': JSON.stringify(built.report, null, 2) + '\n' })) {
    fs.writeFileSync(path.join(out, name), value, { mode: 0o600, flag: 'wx' });
  }
  return built.report;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(prepareSaleOpeningCandidate(process.argv.slice(2)))); }
  catch { console.error('Sale opening candidate failed; no deployment performed.'); process.exitCode = 1; }
}
