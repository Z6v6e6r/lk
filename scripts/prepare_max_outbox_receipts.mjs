import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
const source = n => fs.readFileSync(path.join(root, 'scripts/nodered_max_nodes', n), 'utf8');
const fixture = n => fs.readFileSync(path.join(root, 'scripts/tests/fixtures/max-outbox', n), 'utf8');
const dispatchHashes = new Set(['4dd5179f64eeb568e929248623ccbe742a1eb090e1762462cde8c02a97b687b0', hash(fixture('dispatch-before.js'))]);
const pullHashes = new Set(['ddfc26e5012e7ca5ae1e00ffaa8059cd3f3954a5220ff98dd40b14bb4c575cf2',
  '5c4b8edd814195cbc144c575a5f28959eab0c68ffc13502fd7c0c1f733046c52', hash(fixture('pull-before.js'))]);
const pairs = [
  ['47c460de0db646e6', 'f64e5818bc8d7aa6', '41be3d2c95b57295', 'MAX_BOT', 'main'],
  ['0006d5707259bc5b', '466e8a3ac76c2fab', '2e547e998eee631f', 'MAX_ACADEMY_BOT', 'academy']
];
export function preparePatch(flow) {
  if (!Array.isArray(flow) || new Set(flow.map(n => n.id)).size !== flow.length) throw Error('INVALID_FLOW_IDS');
  const by = new Map(flow.map(n => [n.id, n]));
  const patch = [];
  for (const [dispatchId, senderId, pullId, connector, suffix] of pairs) {
    const dispatch = by.get(dispatchId), sender = by.get(senderId), pull = by.get(pullId);
    if (dispatch?.type !== 'function' || sender?.type !== 'maxbot-send' || pull?.type !== 'function'
      || !dispatchHashes.has(hash(dispatch.func)) || !pullHashes.has(hash(pull.func))
      || (dispatch.wires?.[0]?.length !== 1 || dispatch.wires[0][0] !== senderId) || !sender.bot
      || dispatch.z !== sender.z || pull.z !== sender.z) throw Error('MAX_OUTBOX_PREIMAGE_MISMATCH');
    const sendId = `max_outbox_fenced_send_${suffix}`, prepId = `max_outbox_fenced_receipt_${suffix}`;
    const httpId = `max_outbox_fenced_http_${suffix}`, resultId = `max_outbox_fenced_result_${suffix}`;
    if ([sendId, prepId, httpId, resultId].some(id => by.has(id))) throw Error('MAX_OUTBOX_ALREADY_PATCHED');
    const wires = structuredClone(dispatch.wires);
    wires[0] = wires[0].map(id => id === senderId ? sendId : id);
    patch.push({ ...dispatch, func: source('fn_max_outbox_dispatch_prepare.js'), wires });
    patch.push({ ...pull, func: source('fn_max_outbox_pull_prepare.js').replace('connector=MAX_BOT', `connector=${connector}`) });
    const common = { z: sender.z, x: sender.x, y: sender.y + 160, wires: [] };
    patch.push({ ...common, id: sendId, type: 'max-outbox-send', name: 'MAX fenced outbox send', bot: sender.bot, wires: [[prepId]] });
    patch.push({ ...common, id: prepId, type: 'function', name: 'Prepare MAX fenced receipt',
      func: source('fn_max_outbox_receipt_prepare.js'), outputs: 1, wires: [[httpId]] });
    patch.push({ ...common, id: httpId, type: 'http request', name: 'Persist MAX fenced receipt',
      method: 'use', ret: 'obj', paytoqs: 'ignore', url: '', senderr: true, headers: [], wires: [[resultId]] });
    patch.push({ ...common, id: resultId, type: 'function', name: 'MAX receipt status only', outputs: 0,
      func: "if (!(msg.statusCode >= 200 && msg.statusCode < 300)) node.warn('MAX_OUTBOX_RECEIPT_UNCONFIRMED'); return null;" });
  }
  return patch;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output || !path.isAbsolute(input) || !path.isAbsolute(output)) throw Error('ABSOLUTE_INPUT_OUTPUT_REQUIRED');
  for (const p of [input, output]) if (p === root || p.startsWith(root + path.sep)) throw Error('EXTERNAL_WORKSPACE_REQUIRED');
  const patch = preparePatch(JSON.parse(fs.readFileSync(input, 'utf8')));
  fs.writeFileSync(output, JSON.stringify(patch, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ nodes: patch.length, sha256: hash(JSON.stringify(patch)), imported: false }));
}
