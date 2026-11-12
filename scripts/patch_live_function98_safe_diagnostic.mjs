#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { patchFunction98Flow, sha256 } from './lib/function98_safe_diagnostic.mjs';
import { verifyWorkspace } from './verify_nodered_source_origin.mjs';
import { buildExactGraphContract, validateReviewedFlowContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';

export function composeFunction98Candidate(bytes, expectedFlowSha256, options = {}) {
  if (!/^[a-f0-9]{64}$/.test(expectedFlowSha256) || sha256(bytes) !== expectedFlowSha256) {
    throw new Error('Flow preimage drift');
  }
  let flow;
  try { flow = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('Invalid flow JSON'); }
  const patched = patchFunction98Flow(flow, options);
  const candidateBytes = Buffer.from(`${JSON.stringify(patched.candidate, null, 2)}\n`);
  const contract = buildExactGraphContract({ liveBytes: bytes, candidateBytes,
    deploymentId: 'function98-safe-diagnostic',
    allowedChanges: [{ id: patched.targetId, fields: ['func'] }], allowedAdditionIds: [] });
  validateReviewedFlowContract({ liveBytes: bytes, candidateBytes, contract });
  return { candidateBytes, report: { event: 'function98_safe_diagnostic_candidate',
    sourceSha256: sha256(bytes), candidateSha256: sha256(candidateBytes),
    beforeFunctionSha256: patched.beforeFunctionSha256,
    afterFunctionSha256: patched.afterFunctionSha256,
    changedNodeCount: 1, changedFieldCount: 1, addedNodeCount: 0, topologyUnchanged: true } };
}

function within(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function insideGitCheckout(directory) {
  for (let current = directory; ; current = path.dirname(current)) {
    if (fs.existsSync(path.join(current, '.git'))) return true;
    if (path.dirname(current) === current) return false;
  }
}

export function writePrivateCandidate(output, bytes, workspace) {
  const repo = fs.realpathSync(new URL('..', import.meta.url));
  const parent = path.dirname(output);
  if (!path.isAbsolute(output) || path.resolve(output) !== output
    || fs.realpathSync(parent) !== parent || fs.lstatSync(parent).isSymbolicLink()
    || (fs.statSync(parent).mode & 0o777) !== 0o700
    || within(repo, output) || within(workspace, output) || insideGitCheckout(parent)) {
    throw new Error('New canonical private external output required');
  }
  // O_EXCL rejects existing files, symlinks (including dangling ones) and hardlinks.
  const fd = fs.openSync(output, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
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
  const built = composeFunction98Candidate(bytes, options['--expected-flow-sha256']);
  if (options['--output']) writePrivateCandidate(options['--output'], built.candidateBytes, verified.workspace);
  console.log(JSON.stringify({ ...built.report, candidateWritten: Boolean(options['--output']) }));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try { main(process.argv.slice(2)); }
  catch {
    // All failures are deliberately constant: paths/parser errors can contain secrets.
    console.error('Function98 diagnostic patch refused; check source and workspace guards');
    process.exitCode = 1;
  }
}
