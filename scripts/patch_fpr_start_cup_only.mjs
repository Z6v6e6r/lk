import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { hash } from './patch_fpr_start_bootstrap.mjs';

const initializeId = 'fpr_canonical_bootstrap_20261106';
const authorizeId = 'cup_level_authorize';
const legacyBranch = "if (ctx.operation === 'fprMirror') {";
const onboardingBranch = "if (ctx.operation === 'initialize') {";

export function patchFprStartCupOnly(bytes, contract, initialize) {
  if (hash(bytes) !== contract.sourceSha256) throw new Error('FPR_START_SOURCE_PREIMAGE');
  const flow = JSON.parse(bytes);
  if (!Array.isArray(flow) || new Set(flow.map(node => node.id)).size !== flow.length) {
    throw new Error('FPR_START_GRAPH');
  }
  const exactNode = id => {
    const node = flow.find(item => item.id === id);
    if (node?.type !== 'function' || node.d || hash(JSON.stringify(node)) !== contract.nodes?.[id]) {
      throw new Error('FPR_START_NODE_PREIMAGE');
    }
    return node;
  };
  const authorize = exactNode(authorizeId);
  const bootstrap = exactNode(initializeId);
  const start = authorize.func.indexOf(legacyBranch);
  const end = authorize.func.indexOf(onboardingBranch, start);
  if (start < 0 || end < 0 || JSON.stringify(authorize.wires) !== JSON.stringify([
    ['cup_level_dispatch'], ['cup_level_response'], ['c831f19741603796'],
  ])) throw new Error('FPR_START_LEGACY_ROUTE');
  authorize.func = authorize.func.slice(0, start)
    + "if (ctx.operation === 'fprMirror') return fail(409, 'TOURNAMENT_START_LEVEL_USE_CUP');\n"
    + authorize.func.slice(end);
  authorize.wires[2] = [];
  bootstrap.func = initialize;
  for (const node of [authorize, bootstrap]) new Function('msg', node.func);
  return JSON.stringify(flow, null, 2) + '\n';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, contract, output] = process.argv.slice(2);
  if (!input || !contract || !output) {
    throw new Error('Usage: node scripts/patch_fpr_start_cup_only.mjs INPUT CONTRACT NEW_OUTPUT');
  }
  const initialize = fs.readFileSync(new URL('./nodered_fpr_start_nodes/initialize.js', import.meta.url), 'utf8');
  const bytes = patchFprStartCupOnly(fs.readFileSync(input), JSON.parse(fs.readFileSync(contract)), initialize);
  fs.writeFileSync(output, bytes, { flag: 'wx', mode: 0o600 });
}
