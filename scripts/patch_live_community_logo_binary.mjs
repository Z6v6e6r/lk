#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { addTypedCommunityResponseRedaction } from './lib/communityResponseRedaction.mjs';
import { buildFunctionOnlyContract, sha256 } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';

const MEDIA_IDS = [
  'b274fa471d4654a3', '9fa15a3c8d86528a', '75cd8607d472a975', 'ea4db740fdcd920c',
  '4573edfe3e109f3a', '87fc796ba5710287', '335e7e97639670f2', '4ec662e1ded03673',
];

export function buildCommunityLogoRepairCandidate(sourceBytes, expectedSourceSha256) {
  if (!/^[a-f0-9]{64}$/.test(expectedSourceSha256) || sha256(sourceBytes) !== expectedSourceSha256) {
    throw new Error('Community logo source preimage mismatch');
  }
  const source = JSON.parse(sourceBytes.toString('utf8'));
  if (!Array.isArray(source)) throw new Error('Expected a flow array');
  for (const id of MEDIA_IDS) {
    const node = source.find(item => item.id === id);
    if (node?.type !== 'function' || !/Build (?:legacy )?community logo/.test(node.name)
      || !node.func?.startsWith('// COMMUNITY_TYPED_RESPONSE_REDACTION\n')) {
      throw new Error(`Missing wrapped community media response: ${id}`);
    }
    if (node.outputs !== 2 || node.wires?.length !== 2
      || node.wires[0].length !== 1 || node.wires[1].length !== 1
      || source.find(item => item.id === node.wires[0][0])?.type !== 'http response'
      || source.find(item => item.id === node.wires[1][0])?.type !== 'debug') {
      throw new Error(`Community media response wiring drift: ${id}`);
    }
  }
  for (const name of ['Build communities list response', 'Build community get response', 'Store community logo asset']) {
    if (!source.some(node => node.name === name && node.func?.startsWith('// COMMUNITY_TYPED_RESPONSE_REDACTION\n'))) {
      throw new Error(`Missing wrapped logo URL response: ${name}`);
    }
  }
  // Upgrade known wrappers only. Do not add guards or wrap unrelated functions.
  const candidate = addTypedCommunityResponseRedaction(source, { existingOnly: true });
  const changedIds = source.filter((node, index) => !isDeepStrictEqual(node, candidate[index])).map(node => node.id);
  if (!changedIds.length) throw new Error('Community logo repair is already installed');
  for (const node of candidate) if (changedIds.includes(node.id)) {
    // Compile the exact shipped function, without executing any runtime operation.
    new Function('msg', 'node', 'flow', 'global', 'env', 'Buffer', node.func);
  }
  const candidateBytes = Buffer.from(JSON.stringify(candidate, null, 2) + '\n');
  const contract = buildFunctionOnlyContract({
    liveBytes: sourceBytes, candidateBytes,
    deploymentId: 'community-logo-binary-cache', allowedNodeIds: changedIds,
  });
  return { candidateBytes, contract };
}

function main() {
  const args = new Map();
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i], value = process.argv[i + 1];
    if (!['--input', '--output', '--contract', '--expected-flow-sha256'].includes(key)
      || !value || args.has(key)) throw new Error('Invalid community logo patch arguments');
    args.set(key, value);
  }
  if (args.size !== 4) throw new Error('Expected --input --output --contract --expected-flow-sha256');
  for (const key of ['--input', '--output', '--contract']) {
    if (!path.isAbsolute(args.get(key))) throw new Error('Use absolute external artifact paths');
  }
  const output = args.get('--output'), contractPath = args.get('--contract');
  if (output === contractPath || fs.existsSync(output) || fs.existsSync(contractPath)) {
    throw new Error('Artifact destinations must be distinct and must not exist');
  }
  const { candidateBytes, contract } = buildCommunityLogoRepairCandidate(
    fs.readFileSync(args.get('--input')), args.get('--expected-flow-sha256'),
  );
  fs.writeFileSync(output, candidateBytes, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(contractPath, JSON.stringify(contract, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({
    deploymentId: contract.deploymentId, sourceSha256: contract.sourceSha256,
    candidateSha256: contract.candidateSha256, changedNodeCount: contract.allowedChanges.length,
    httpInputCount: contract.httpInputCount,
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
