import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { verifyWorkspace } from './verify_nodered_source_origin.mjs';

export const RESET_CONFIRM_NODE = 'ca022fd14027a5b0';
export const RESET_CONFIRM_PREIMAGE = 'd76cdb6391bc8ffb4514dc61c60b9360aa03da5fa5d2f3f9e16df30bbb404674';
const anchor = '// All selected confirmations pass the durable admission gate before provider I/O.';
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
export function resetReceiptBlock() {
  const source = fs.readFileSync(new URL('./nodered_games_nodes/fn_tournament_subscription_confirm_resolve.js', import.meta.url), 'utf8');
  const start = source.indexOf('// BEGIN storefront verified checkout reset receipt');
  const end = source.indexOf('// END storefront verified checkout reset receipt', start);
  if (start < 0 || end < 0) throw Error('Missing reviewed reset receipt source');
  return source.slice(start, end + '// END storefront verified checkout reset receipt'.length) + '\n\n';
}
export function patchCheckoutResetBody(body, expected = RESET_CONFIRM_PREIMAGE) {
  if (sha(body) !== expected || body.includes('// BEGIN storefront verified checkout reset receipt') || body.split(anchor).length !== 2) throw Error('Confirm resolver preimage drift');
  const result = body.replace(anchor, resetReceiptBlock() + anchor);
  new Function('msg', 'node', 'global', 'flow', 'env', result);
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [workspace, output] = process.argv.slice(2);
  if (!workspace || !output || fs.existsSync(output)) throw Error('Usage: <fresh private live workspace> <new candidate path>');
  const verified = verifyWorkspace(workspace);
  const input = path.join(verified.workspace, 'input/source.flow.json');
  const flow = JSON.parse(fs.readFileSync(input, 'utf8'));
  const node = flow.find(n => n.id === RESET_CONFIRM_NODE);
  if (!node || node.type !== 'function' || node.outputs !== 5) throw Error('Confirm node contract drift');
  node.func = patchCheckoutResetBody(node.func);
  fs.writeFileSync(output, JSON.stringify(flow, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ changedNode: node.id, sourceBodySha256: RESET_CONFIRM_PREIMAGE, candidateBodySha256: sha(node.func) }));
}
