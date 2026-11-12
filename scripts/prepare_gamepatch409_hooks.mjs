import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applySourceHooks, sha } from './diagnostics/source-hooks.mjs';
import { buildFunctionOnlyContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bindings = [
  ['partner_roster_authorize_20261012', 'scripts/nodered_partner_roster_nodes/fn_authorize.js'],
  ['partner_roster_ack_20261012', 'scripts/nodered_partner_roster_nodes/fn_ack.js'],
];
export function prepareGamePatchHooks(liveBytes, sourceRoot = root) {
  const flow = JSON.parse(liveBytes), attestations = [];
  for (const url of ['/lk/games/:gameId', '/lk/games/records/:gameId']) {
    const routes = flow.filter(n => n.type === 'http in' && n.method === 'patch' && n.url === url && !n.d);
    if (routes.length !== 1 || flow.find(n => n.id === routes[0].z)?.disabled) throw Error('PATCH_ROUTE_DRIFT');
    const route = routes[0];
    const set = bindings.map(([id, sourcePath]) => {
      const nodes = flow.filter(n => n.id === id && n.type === 'function' && !n.d);
      if (nodes.length !== 1) throw Error('PATCH_NODE_DRIFT');
      return { id, path: sourcePath, preimageHash: sha(nodes[0].func),
        candidateHash: sha(fs.readFileSync(path.join(sourceRoot, sourcePath), 'utf8')),
        routeId: route.id, routeHash: sha(JSON.stringify(route)) };
    });
    // Validate each route independently against the original source, not a partly patched graph.
    applySourceHooks(flow, set, sourceRoot);
    if (!attestations.length) attestations.push(...set);
  }
  const candidateBytes = Buffer.from(JSON.stringify(applySourceHooks(flow, attestations, sourceRoot), null, 2) + '\n');
  const contract = buildFunctionOnlyContract({ liveBytes, candidateBytes,
    deploymentId: 'game-patch369-hooks', allowedNodeIds: bindings.map(([id]) => id) });
  return { candidateBytes, contract, attestations };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [input, output] = process.argv.slice(2);
  if (!path.isAbsolute(input || '') || !path.isAbsolute(output || '') || fs.existsSync(output)) throw Error('PRIVATE_NEW_OUTPUT_REQUIRED');
  const parent = fs.realpathSync(path.dirname(output));
  if (parent === root || parent.startsWith(root + path.sep)) throw Error('PRIVATE_NEW_OUTPUT_REQUIRED');
  const result = prepareGamePatchHooks(fs.readFileSync(input));
  fs.mkdirSync(output, { mode: 0o700 });
  for (const [name, bytes] of [['candidate.flow.json', result.candidateBytes], ['contract.json', JSON.stringify(result.contract)], ['attestations.json', JSON.stringify(result.attestations)]]) {
    fs.writeFileSync(path.join(output, name), bytes, { mode: 0o600, flag: 'wx' });
  }
  console.log(JSON.stringify({ changedFunctions: result.contract.allowedChanges.length,
    sourceSha256: result.contract.sourceSha256, candidateSha256: result.contract.candidateSha256, activationPerformed: false }));
}
