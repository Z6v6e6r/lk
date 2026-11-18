#!/usr/bin/env node
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { patchFunction296Flow } from './lib/function296_safe_diagnostic.mjs';
import { sha256 } from './lib/function98_safe_diagnostic.mjs';
import { writePrivateCandidate } from './patch_live_function98_safe_diagnostic.mjs';
import { verifyWorkspace } from './verify_nodered_source_origin.mjs';
import { buildExactGraphContract, validateReviewedFlowContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';

export function composeFunction296Candidate(bytes, expectedFlowSha256, options = {}) {
  if (!/^[a-f0-9]{64}$/.test(expectedFlowSha256) || sha256(bytes) !== expectedFlowSha256) {
    throw new Error('Flow preimage drift');
  }
  let flow;
  try { flow = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('Invalid flow JSON'); }
  const patched = patchFunction296Flow(flow, options);
  const candidateBytes = Buffer.from(`${JSON.stringify(patched.candidate, null, 2)}\n`);
  const contract = buildExactGraphContract({ liveBytes: bytes, candidateBytes,
    deploymentId: 'function296-safe-diagnostic',
    allowedChanges: [{ id: patched.targetId, fields: ['func'] }], allowedAdditionIds: [] });
  validateReviewedFlowContract({ liveBytes: bytes, candidateBytes, contract });
  return { candidateBytes, report: { event: 'function296_safe_diagnostic_candidate',
    sourceSha256: sha256(bytes), candidateSha256: sha256(candidateBytes),
    beforeFunctionSha256: patched.beforeFunctionSha256,
    afterFunctionSha256: patched.afterFunctionSha256,
    changedNodeCount: 1, changedFieldCount: 1, addedNodeCount: 0,
    topologyUnchanged: true, scheduleUnchanged: true, httpConfigurationUnchanged: true } };
}

export function main(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!['--workspace', '--expected-flow-sha256', '--output'].includes(key)
      || options[key] !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) {
      throw new Error('Invalid patcher arguments');
    }
    options[key] = args[i + 1];
  }
  if (!options['--workspace'] || !options['--expected-flow-sha256']) {
    throw new Error('Workspace and reviewed whole-flow hash required');
  }
  const verified = verifyWorkspace(options['--workspace'], { quiet: true });
  const bytes = fs.readFileSync(verified.sourcePath);
  if (sha256(bytes) !== verified.sourceSha256) throw new Error('Verified source changed');
  const built = composeFunction296Candidate(bytes, options['--expected-flow-sha256']);
  if (options['--output']) writePrivateCandidate(options['--output'], built.candidateBytes, verified.workspace);
  console.log(JSON.stringify({ ...built.report, candidateWritten: Boolean(options['--output']) }));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try { main(process.argv.slice(2)); }
  catch {
    // Parser/path errors can quote credential-bearing input. Never export them.
    console.error('Function296 diagnostic patch refused; check source and workspace guards');
    process.exitCode = 1;
  }
}
